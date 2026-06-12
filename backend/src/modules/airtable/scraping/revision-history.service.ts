import { randomUUID } from 'node:crypto';
import type { Logger } from '../../../core/logger/index.js';
import type { IRateLimiter } from '../../../infrastructure/rate-limit/rate-limiter.interface.js';
import { ScrapingError, SessionExpiredError } from '../../../core/errors/index.js';
import type { ISessionOrchestrator, HarvestedSession } from './session-orchestrator.interface.js';
import type { IRevisionHistoryParser, RawActivityItem } from './revision-history-parser.interface.js';
import type { IRevisionHistoryService } from './revision-history.service.interface.js';
import type { IRevisionHistoryRepository } from '../models/revision-history.repository.interface.js';
import type { IUserRepository, UserDocument } from '../models/user.repository.interface.js';
import type { RevisionHistoryDocument } from '../models/revision-history.repository.interface.js';

// ── Airtable internal API ─────────────────────────────────────────────────────

/**
 * Endpoint URL template for the row-activity feed.
 * `{baseId}` = the `appXXX` base ID.
 * `{tableId}` = the `tblXXX` table ID.
 */
const ENDPOINT = (baseId: string, tableId: string) =>
  `https://airtable.com/v0.3/${baseId}/${tableId}/readRowActivitiesAndComments`;

const SCRAPE_RATE_LIMIT_KEY = 'airtable.com';
const PAGE_SIZE = 50;
const MAX_RE_AUTH_RETRIES = 1;

// ── Response types ────────────────────────────────────────────────────────────

interface RawActivity {
  rowId: string;
  groupType: string;
  createdTime: string;
  originatingUserId: string;
  diffRowHtml?: string;
}

interface RawUser {
  id?: string;
  email?: string;
  name?: string;
  profilePicUrl?: string | null;
}

interface ActivityResponse {
  rowActivityInfoById: Record<string, RawActivity>;
  rowActivityOrCommentUserObjById?: Record<string, RawUser>;
  offsetV2?: string;
  error?: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class RevisionHistoryService implements IRevisionHistoryService {
  constructor(
    private readonly sessionOrchestrator: ISessionOrchestrator,
    private readonly parser: IRevisionHistoryParser,
    private readonly revisionHistoryRepository: IRevisionHistoryRepository,
    private readonly userRepository: IUserRepository,
    private readonly rateLimiter: IRateLimiter,
    private readonly log: Logger,
  ) {}

  async scrapeForPage(baseId: string, tableId: string, rowId: string): Promise<void> {
    const session = await this.sessionOrchestrator.getSession();
    await this.fetchAllPages(baseId, tableId, rowId, session, 0);
  }

  // ── Pagination loop ─────────────────────────────────────────────────────────

  private async fetchAllPages(
    baseId: string,
    tableId: string,
    rowId: string,
    session: HarvestedSession,
    retryCount: number,
  ): Promise<void> {
    const revisions: RevisionHistoryDocument[] = [];
    const usersMap = new Map<string, UserDocument>();
    let offsetV2: string | null = null;

    do {
      await this.rateLimiter.acquire(SCRAPE_RATE_LIMIT_KEY);

      const params = {
        rowId,
        limit: PAGE_SIZE,
        ...(offsetV2 !== null ? { offsetV2 } : {}),
        shouldReturnDeserializedActivityItems: true,
        shouldIncludeRowActivityOrCommentUserObjById: true,
        secretSocketId: session.tokens.secretSocketId,
      };

      const cookieHeader = session.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const body = new URLSearchParams({
        stringifiedObjectParams: JSON.stringify(params),
        requestId: randomUUID(),
      });

      let response: Response;
      try {
        response = await fetch(ENDPOINT(baseId, tableId), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieHeader,
            'x-requested-with': 'XMLHttpRequest',
            'x-airtable-application-id': baseId,
          },
          body: body.toString(),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new ScrapingError(
          `Network error fetching revision history for ${rowId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Re-auth on 401/403
      if (response.status === 401 || response.status === 403) {
        if (retryCount < MAX_RE_AUTH_RETRIES) {
          this.log.warn('Session expired mid-scrape — re-authenticating', { rowId });
          await this.sessionOrchestrator.invalidateSession();
          const newSession = await this.sessionOrchestrator.getSession();
          return this.fetchAllPages(baseId, tableId, rowId, newSession, retryCount + 1);
        }
        throw new SessionExpiredError();
      }

      if (!response.ok) {
        throw new ScrapingError(
          `readRowActivitiesAndComments returned ${response.status} for row ${rowId}`,
        );
      }

      const data = (await response.json()) as ActivityResponse;

      if (data.error) {
        throw new ScrapingError(`Airtable API error for row ${rowId}: ${data.error}`);
      }

      // ── Extract users ───────────────────────────────────────────────────────
      for (const [userId, userInfo] of Object.entries(
        data.rowActivityOrCommentUserObjById ?? {},
      )) {
        usersMap.set(userId, {
          airtableId: userId,
          email: userInfo.email ?? '',
          name: userInfo.name ?? userId,
          profilePicUrl: userInfo.profilePicUrl ?? null,
        });
      }

      // ── Parse activity items ────────────────────────────────────────────────
      for (const [activityId, item] of Object.entries(data.rowActivityInfoById)) {
        if (!item.diffRowHtml) continue;

        const rawItem: RawActivityItem = {
          activityId,
          ticketId: item.rowId || rowId,
          createdTime: item.createdTime,
          originatingUserId: item.originatingUserId,
          diffRowHtml: item.diffRowHtml,
          groupType: item.groupType,
        };

        const parsed = this.parser.parse(rawItem);
        if (parsed) revisions.push(parsed);
      }

      offsetV2 = data.offsetV2 ?? null;
    } while (offsetV2 !== null);

    // ── Persist ─────────────────────────────────────────────────────────────
    const users = Array.from(usersMap.values());
    await Promise.all([
      this.revisionHistoryRepository.upsertMany(revisions),
      this.userRepository.upsertMany(users),
    ]);

    this.log.info('Revision history scraped', {
      rowId,
      revisionCount: revisions.length,
      userCount: users.length,
    });
  }
}

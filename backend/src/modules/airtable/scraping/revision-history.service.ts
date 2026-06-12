import { randomUUID } from 'node:crypto';
import type { Logger } from '../../../core/logger/index.js';
import type { IRateLimiter } from '../../../infrastructure/rate-limit/rate-limiter.interface.js';
import { ScrapingError, SessionExpiredError } from '../../../core/errors/index.js';
import type { ISessionOrchestrator } from './session-orchestrator.interface.js';
import type { IRevisionHistoryParser, RawActivityItem } from './revision-history-parser.interface.js';
import type { IRevisionHistoryService } from './revision-history.service.interface.js';
import type { IRevisionHistoryRepository } from '../models/revision-history.repository.interface.js';
import type { IUserRepository, UserDocument } from '../models/user.repository.interface.js';
import type { RevisionHistoryDocument } from '../models/revision-history.repository.interface.js';

// ── Airtable internal API ─────────────────────────────────────────────────────

const ENDPOINT = (rowId: string) =>
  `https://airtable.com/v0.3/row/${rowId}/readRowActivitiesAndComments`;

const SCRAPE_RATE_LIMIT_KEY = 'airtable.com';
const PAGE_SIZE = 50;

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

interface ActivityPayload {
  rowActivityInfoById: Record<string, RawActivity>;
  rowActivityOrCommentUserObjById?: Record<string, RawUser>;
  offsetV2?: string | null;
  isRevisionHistoryDisabled?: boolean;
}

interface ActivityResponse {
  msg?: string;
  // API wraps payload under `data`
  data?: ActivityPayload;
  // Legacy flat shape (kept for compatibility)
  rowActivityInfoById?: Record<string, RawActivity>;
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

  async scrapeForPage(baseId: string, _tableId: string, rowId: string): Promise<void> {
    await this.fetchAllPages(baseId, rowId);
  }

  // ── Pagination loop ─────────────────────────────────────────────────────────

  private async fetchAllPages(
    baseId: string,
    rowId: string,
  ): Promise<void> {
    const revisions: RevisionHistoryDocument[] = [];
    const usersMap = new Map<string, UserDocument>();
    let offsetV2: string | null = null;

    do {
      await this.rateLimiter.acquire(SCRAPE_RATE_LIMIT_KEY);

      // Omit secretSocketId — the browser's live socket connection handles
      // real-time updates server-side; we only need the synchronous response.
      const params = {
        rowId,
        limit: PAGE_SIZE,
        ...(offsetV2 !== null ? { offsetV2 } : {}),
        shouldReturnDeserializedActivityItems: true,
        shouldIncludeRowActivityOrCommentUserObjById: true,
      };

      const formBody = new URLSearchParams({
        stringifiedObjectParams: JSON.stringify(params),
        requestId: randomUUID(),
      });

      // Use the live Puppeteer browser so the browser's own cookie store and
      // socket state are used — avoids manually reconstructing auth in Node.js.
      let result: { status: number; text: string };
      try {
        result = await this.sessionOrchestrator.makeBrowserFetch(
          ENDPOINT(rowId),
          formBody.toString(),
          {
            'x-requested-with': 'XMLHttpRequest',
            'x-airtable-application-id': baseId,
            'x-time-zone': 'UTC',
          },
        );
      } catch (err) {
        throw new ScrapingError(
          `Network error fetching revision history for ${rowId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (result.status === 401 || result.status === 403) {
        this.log.warn('Auth failure on revision history API — invalidating session and retrying', {
          rowId,
          status: result.status,
        });
        await this.sessionOrchestrator.invalidateSession();
        // Retry once with fresh session; throw SessionExpiredError if it fails again.
        try {
          result = await this.sessionOrchestrator.makeBrowserFetch(
            ENDPOINT(rowId),
            formBody.toString(),
            {
              'x-requested-with': 'XMLHttpRequest',
              'x-airtable-application-id': baseId,
              'x-time-zone': 'UTC',
            },
          );
        } catch (retryErr) {
          throw new ScrapingError(
            `Network error on retry for ${rowId}: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          );
        }
        if (result.status === 401 || result.status === 403) {
          this.log.warn('Auth failure persisted after session refresh', { rowId, status: result.status });
          throw new SessionExpiredError();
        }
      }

      if (result.status < 200 || result.status >= 300) {
        throw new ScrapingError(
          `readRowActivitiesAndComments returned ${result.status} for row ${rowId}: ${result.text.slice(0, 300)}`,
        );
      }

      const envelope = JSON.parse(result.text) as ActivityResponse;

      if (envelope.error) {
        throw new ScrapingError(`Airtable API error for row ${rowId}: ${envelope.error}`);
      }

      // Unwrap nested `data` payload (API wraps response as { msg, data: { ... } })
      const payload: ActivityPayload = envelope.data ?? ({
        rowActivityInfoById: envelope.rowActivityInfoById ?? {},
        rowActivityOrCommentUserObjById: envelope.rowActivityOrCommentUserObjById,
        offsetV2: envelope.offsetV2,
      } as ActivityPayload);

      if (payload.isRevisionHistoryDisabled) {
        this.log.warn('Revision history disabled for row', { rowId });
        break;
      }

      // ── Extract users ───────────────────────────────────────────────────────
      for (const [userId, userInfo] of Object.entries(
        payload.rowActivityOrCommentUserObjById ?? {},
      )) {
        usersMap.set(userId, {
          airtableId: userId,
          email: userInfo.email ?? '',
          name: userInfo.name ?? userId,
          profilePicUrl: userInfo.profilePicUrl ?? null,
        });
      }

      // ── Parse activity items ────────────────────────────────────────────────
      for (const [activityId, item] of Object.entries(payload.rowActivityInfoById)) {
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

      offsetV2 = payload.offsetV2 ?? null;
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

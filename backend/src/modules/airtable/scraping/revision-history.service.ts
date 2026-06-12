import { randomUUID } from "node:crypto";
import type { Logger } from "../../../core/logger/index.js";
import type { IRateLimiter } from "../../../infrastructure/rate-limit/rate-limiter.interface.js";
import { ScrapingError } from "../../../core/errors/index.js";
import type { ISessionOrchestrator } from "./session-orchestrator.interface.js";
import type {
  IRevisionHistoryParser,
  RawActivityItem,
} from "./revision-history-parser.interface.js";
import type { IRevisionHistoryService } from "./revision-history.service.interface.js";
import type { IRevisionHistoryRepository } from "../models/revision-history.repository.interface.js";
import type {
  IUserRepository,
  UserDocument,
} from "../models/user.repository.interface.js";
import type { RevisionHistoryDocument } from "../models/revision-history.repository.interface.js";

// ── Airtable internal API ─────────────────────────────────────────────────────

const ENDPOINT = (rowId: string) =>
  `https://airtable.com/v0.3/row/${rowId}/readRowActivitiesAndComments`;

const SCRAPE_RATE_LIMIT_KEY = "airtable.com";
const PAGE_SIZE = 10;

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

  async scrapeForPage(
    baseId: string,
    _tableId: string,
    rowId: string,
  ): Promise<void> {
    await this.fetchAllPages(baseId, rowId);
  }

  // ── Pagination loop ─────────────────────────────────────────────────────────

  private async fetchAllPages(baseId: string, rowId: string): Promise<void> {
    const revisions: RevisionHistoryDocument[] = [];
    const usersMap = new Map<string, UserDocument>();
    let offsetV2: string | null = null;

    const { tokens } = await this.sessionOrchestrator.getSession();

    // Navigate to the specific base before making API calls. Airtable's internal
    // API requires the page to be in the correct base context so that the auth
    // state (XSRF token, service JWT) is initialised for that base. Without this,
    // the page may be sitting at the workspace hub which lacks the per-base auth
    // context and the API returns INVALID_AUTH_TOKEN.
    await this.sessionOrchestrator.navigateActivePage(
      `https://airtable.com/${baseId}`,
    );

    do {
      await this.rateLimiter.acquire(SCRAPE_RATE_LIMIT_KEY);

      // Airtable's internal API uses GET with URL query parameters (not POST).
      // - rowId goes in the URL path, not in stringifiedObjectParams.
      // - secretSocketId is a top-level query param, not inside the JSON object.
      // - offsetV2 must be included explicitly (even as null) on the first page.
      const objParams = {
        limit: PAGE_SIZE,
        offsetV2: offsetV2,
        shouldReturnDeserializedActivityItems: true,
        shouldIncludeRowActivityOrCommentUserObjById: true,
      };

      const queryParams = new URLSearchParams({
        stringifiedObjectParams: JSON.stringify(objParams),
        requestId: randomUUID(),
      });
      if (tokens.secretSocketId) {
        queryParams.set("secretSocketId", tokens.secretSocketId);
      }

      const fetchUrl = `${ENDPOINT(rowId)}?${queryParams.toString()}`;

      // Use the live Puppeteer browser so the browser's own cookie store and
      // socket state are used — avoids manually reconstructing auth in Node.js.
      let result: { status: number; text: string };
      try {
        result = await this.sessionOrchestrator.makeBrowserFetch(
          fetchUrl,
          "",
          {
            "x-requested-with": "XMLHttpRequest",
            "x-airtable-application-id": baseId,
            // Per-request UUID required by Airtable's internal API for
            // deduplication and anti-CSRF purposes.
            "x-airtable-client-queue-id": randomUUID(),
            // Identifies this as a web-client request; some Airtable endpoints
            // require this header to permit access.
            "x-airtable-inter-service-client": "webClient",
            "x-time-zone": "UTC",
          },
          "GET",
        );
      } catch (err) {
        throw new ScrapingError(
          `Network error fetching revision history for ${rowId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (result.status === 401 || result.status === 403) {
        // Log the full response snippet so we can see Airtable's exact error message.
        // Do NOT call invalidateSession() here — a single 401 may be a per-row
        // permission issue or a transient API error, not a real session expiry.
        // Invalidating on the first 401 cascades failures to all remaining pages
        // because subsequent jobs find no active session and abort immediately.
        // The session stays valid; this row is marked error and other rows proceed.
        this.log.warn("Revision history API returned auth error — skipping row", {
          rowId,
          status: result.status,
          responseSnippet: result.text.slice(0, 500),
        });
        throw new ScrapingError(
          `Revision history API returned ${result.status} for row ${rowId}`,
        );
      }

      if (result.status < 200 || result.status >= 300) {
        throw new ScrapingError(
          `readRowActivitiesAndComments returned ${result.status} for row ${rowId}: ${result.text.slice(0, 300)}`,
        );
      }

      const envelope = JSON.parse(result.text) as ActivityResponse;

      if (envelope.error) {
        throw new ScrapingError(
          `Airtable API error for row ${rowId}: ${envelope.error}`,
        );
      }

      // Unwrap nested `data` payload (API wraps response as { msg, data: { ... } })
      const payload: ActivityPayload =
        envelope.data ??
        ({
          rowActivityInfoById: envelope.rowActivityInfoById ?? {},
          rowActivityOrCommentUserObjById:
            envelope.rowActivityOrCommentUserObjById,
          offsetV2: envelope.offsetV2,
        } as ActivityPayload);

      if (payload.isRevisionHistoryDisabled) {
        this.log.warn("Revision history disabled for row", { rowId });
        break;
      }

      // ── Extract users ───────────────────────────────────────────────────────
      for (const [userId, userInfo] of Object.entries(
        payload.rowActivityOrCommentUserObjById ?? {},
      )) {
        usersMap.set(userId, {
          airtableId: userId,
          email: userInfo.email ?? "",
          name: userInfo.name ?? userId,
          profilePicUrl: userInfo.profilePicUrl ?? null,
        });
      }

      // ── Parse activity items ────────────────────────────────────────────────
      for (const [activityId, item] of Object.entries(
        payload.rowActivityInfoById,
      )) {
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

    this.log.info("Revision history scraped", {
      rowId,
      revisionCount: revisions.length,
      userCount: users.length,
    });
  }
}

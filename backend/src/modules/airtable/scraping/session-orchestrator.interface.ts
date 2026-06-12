import type { ScrapeSessionDocument, SerializedCookie, HarvestedTokens } from '../models/scrape-session.repository.interface.js';

export interface HarvestedSession {
  cookies: SerializedCookie[];
  tokens: HarvestedTokens;
}

export interface LoginStartResult {
  sessionId: string;
  state: string;
}

export interface ISessionOrchestrator {
  /**
   * Initiates a login if no valid session exists. Waits until MFA detection
   * before returning so the caller receives an accurate state:
   * "awaiting_mfa" or "active".
   */
  startLogin(): Promise<LoginStartResult>;
  /** Returns an active session, blocking until login completes (used by Phase 7). */
  getSession(): Promise<HarvestedSession>;
  /**
   * Waits for the in-progress login (including post-MFA steps) to fully
   * complete and returns the harvested session. Used after submitMfaCode().
   */
  awaitLoginComplete(): Promise<HarvestedSession>;
  /** Feeds an MFA code into a pending Puppeteer login flow. */
  submitMfaCode(sessionId: string, code: string): Promise<void>;
  /** Returns current session state from DB. */
  getSessionState(): Promise<ScrapeSessionDocument | null>;
  /** Validates the session cookies and marks as expired if invalid. */
  validateSession(): Promise<boolean>;
  /** Forces a fresh login, discarding the current session. */
  invalidateSession(): Promise<void>;
  /**
   * Makes an authenticated request from within the Puppeteer browser so that
   * the browser's own cookie store and socket connection are used.
   * This is the only reliable way to call Airtable internal APIs that require
   * a live session — manual Node.js fetch with copied cookies fails because
   * Airtable validates the session differently for server-side requests.
   *
   * `method` defaults to "POST". Pass "GET" for read endpoints (e.g.
   * readRowActivitiesAndComments) — these authenticate via cookies only and
   * must not include a request body or Content-Type header.
   */
  makeBrowserFetch(
    url: string,
    body: string,
    headers: Record<string, string>,
    method?: 'GET' | 'POST',
  ): Promise<{ status: number; text: string }>;
  /**
   * Navigates the active Puppeteer page to the given URL.
   * Call this before making internal API calls for a specific Airtable base to
   * ensure the page has the correct auth context loaded for that base.
   */
  navigateActivePage(url: string): Promise<void>;
}

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
   * Initiates a login if no valid session exists. Returns the sessionId +
   * initial state immediately; the actual Puppeteer login runs in the
   * background. Call `getSessionState()` to poll progress.
   */
  startLogin(): Promise<LoginStartResult>;
  /** Returns an active session, blocking until login completes (used by Phase 7). */
  getSession(): Promise<HarvestedSession>;
  /** Feeds an MFA code into a pending Puppeteer login flow. */
  submitMfaCode(sessionId: string, code: string): Promise<void>;
  /** Returns current session state from DB. */
  getSessionState(): Promise<ScrapeSessionDocument | null>;
  /** Validates the session cookies and marks as expired if invalid. */
  validateSession(): Promise<boolean>;
  /** Forces a fresh login, discarding the current session. */
  invalidateSession(): Promise<void>;
}

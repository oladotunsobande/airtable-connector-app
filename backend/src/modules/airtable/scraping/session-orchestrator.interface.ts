import type { ScrapeSessionDocument, SerializedCookie, HarvestedTokens } from '../models/scrape-session.repository.interface.js';

export interface HarvestedSession {
  cookies: SerializedCookie[];
  tokens: HarvestedTokens;
}

export interface ISessionOrchestrator {
  /** Returns an active session, creating one via Puppeteer if needed. */
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

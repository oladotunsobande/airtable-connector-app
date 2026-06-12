import crypto from 'node:crypto';
import type { Page } from 'puppeteer';
import type { AppConfig } from '../../../config/index.js';
import type { Logger } from '../../../core/logger/index.js';
import type { IBrowserManager } from '../../../infrastructure/browser/browser-manager.interface.js';
import type {
  IScrapeSessionRepository,
  ScrapeSessionDocument,
  SerializedCookie,
  HarvestedTokens,
} from '../models/scrape-session.repository.interface.js';
import type {
  ISessionOrchestrator,
  HarvestedSession,
  LoginStartResult,
} from './session-orchestrator.interface.js';
import { ScrapingError, SessionExpiredError } from '../../../core/errors/index.js';

// ── Airtable DOM selectors (isolated so they're easy to update) ───────────────
const SEL = {
  emailInput: 'input[name="email"]',
  passwordInput: 'input[name="password"]',
  submitButton: 'button[type="submit"]',
  // TOTP / authenticator MFA
  mfaInput: 'input[autocomplete="one-time-code"], input[name="otpCode"], input[name="otp_attempt"]',
  mfaSubmit: 'button[type="submit"]',
  // Reliable sign that we have a logged-in workspace
  workspaceIndicator: '[data-testid="workspace-hub-page"], [data-testid="workspace-page"]',
} as const;

const AIRTABLE_LOGIN_URL = 'https://airtable.com/login';
const SESSION_TTL_MS = 6 * 60 * 60 * 1_000; // 6 hours
const MFA_TIMEOUT_MS = 5 * 60 * 1_000;       // 5 minutes
const HARVEST_TIMEOUT_MS = 30_000;            // 30 s to capture secretSocketId

// ── Internal types ────────────────────────────────────────────────────────────

interface MfaWaiter {
  resolveWithCode: (code: string) => void;
  rejectWithError: (err: Error) => void;
}

export class SessionOrchestrator implements ISessionOrchestrator {
  /** Shared in-progress login promise — prevents parallel logins. */
  private loginPromise: Promise<HarvestedSession> | null = null;
  /** Pending MFA confirmations keyed by sessionId. */
  private readonly mfaWaiters = new Map<string, MfaWaiter>();

  constructor(
    private readonly config: AppConfig,
    private readonly browserManager: IBrowserManager,
    private readonly sessionRepository: IScrapeSessionRepository,
    private readonly log: Logger,
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  async startLogin(): Promise<LoginStartResult> {
    const existing = await this.sessionRepository.findActive();
    if (existing?.state === 'awaiting_mfa') {
      return { sessionId: existing.sessionId, state: 'awaiting_mfa' };
    }
    if (existing?.state === 'active' && existing.harvestedTokens) {
      const valid = await this.validateWithSession(existing);
      if (valid) return { sessionId: existing.sessionId, state: 'active' };
      await this.sessionRepository.updateState(existing.sessionId, 'expired');
    }

    const sessionId = crypto.randomUUID();
    await this.sessionRepository.save({
      sessionId,
      cookies: [],
      harvestedTokens: null,
      state: 'active',
      validatedAt: null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });

    // Fire-and-forget; `loginPromise` prevents duplicate logins.
    if (!this.loginPromise) {
      this.loginPromise = this.performLogin(sessionId).finally(() => {
        this.loginPromise = null;
      });
      this.loginPromise.catch((err: unknown) => {
        this.log.error('Background login failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return { sessionId, state: 'active' };
  }

  async getSession(): Promise<HarvestedSession> {
    const existing = await this.sessionRepository.findActive();
    if (existing?.state === 'active' && existing.harvestedTokens) {
      const valid = await this.validateWithSession(existing);
      if (valid) return { cookies: existing.cookies, tokens: existing.harvestedTokens };
      await this.sessionRepository.updateState(existing.sessionId, 'expired');
    }

    if (this.loginPromise) return this.loginPromise;

    const sessionId = crypto.randomUUID();
    await this.sessionRepository.save({
      sessionId,
      cookies: [],
      harvestedTokens: null,
      state: 'active',
      validatedAt: null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });

    this.loginPromise = this.performLogin(sessionId).finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  async submitMfaCode(sessionId: string, code: string): Promise<void> {
    const waiter = this.mfaWaiters.get(sessionId);
    if (!waiter) {
      throw new ScrapingError(`No pending MFA flow for session '${sessionId}'`);
    }
    this.log.info('MFA code received', { sessionId });
    waiter.resolveWithCode(code);
  }

  async getSessionState(): Promise<ScrapeSessionDocument | null> {
    return this.sessionRepository.findActive();
  }

  async validateSession(): Promise<boolean> {
    const session = await this.sessionRepository.findActive();
    if (!session) return false;
    return this.validateWithSession(session);
  }

  async invalidateSession(): Promise<void> {
    const session = await this.sessionRepository.findActive();
    if (session) {
      await this.sessionRepository.updateState(session.sessionId, 'expired');
      this.log.info('Session invalidated', { sessionId: session.sessionId });
    }
  }

  // ── Puppeteer login flow ────────────────────────────────────────────────────

  private async performLogin(sessionId: string): Promise<HarvestedSession> {
    const page = await this.browserManager.newPage();
    this.log.info('Puppeteer login started', { sessionId });

    try {
      // ── Set up request interception to harvest secretSocketId ─────────────
      let capturedSocketId: string | null = null;
      let resolveSocketId: ((id: string) => void) | null = null;
      const socketIdPromise = new Promise<string | null>((resolve) => {
        resolveSocketId = resolve;
        setTimeout(() => resolve(null), HARVEST_TIMEOUT_MS);
      });

      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.url().includes('readRowActivitiesAndComments') && !capturedSocketId) {
          const body = req.postData() ?? '';
          try {
            const params = new URLSearchParams(body);
            const objStr = params.get('stringifiedObjectParams');
            if (objStr) {
              const obj = JSON.parse(objStr) as Record<string, unknown>;
              if (typeof obj['secretSocketId'] === 'string') {
                capturedSocketId = obj['secretSocketId'];
                resolveSocketId?.(capturedSocketId);
              }
            }
          } catch { /* ignore parse errors */ }
        }
        void req.continue().catch(() => {});
      });

      // ── Navigate to login ─────────────────────────────────────────────────
      await page.goto(AIRTABLE_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // ── Step 1: email ─────────────────────────────────────────────────────
      await page.waitForSelector(SEL.emailInput, { timeout: 15_000 });
      await page.type(SEL.emailInput, this.config.airtable.loginEmail, { delay: 40 });

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {}),
        page.click(SEL.submitButton),
      ]);

      // ── Step 2: password ──────────────────────────────────────────────────
      await page.waitForSelector(SEL.passwordInput, { timeout: 15_000 });
      await page.type(SEL.passwordInput, this.config.airtable.loginPassword, { delay: 40 });

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {}),
        page.click(SEL.submitButton),
      ]);

      // ── MFA detection ─────────────────────────────────────────────────────
      const hasMfa = await this.detectMfa(page);
      if (hasMfa) {
        this.log.info('MFA challenge detected', { sessionId });
        await this.sessionRepository.updateState(sessionId, 'awaiting_mfa');

        const code = await this.awaitMfaCode(sessionId);

        await page.waitForSelector(SEL.mfaInput, { timeout: 10_000 });
        await page.type(SEL.mfaInput, code, { delay: 40 });

        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {}),
          page.click(SEL.mfaSubmit),
        ]);

        await this.sessionRepository.updateState(sessionId, 'active');
        this.log.info('MFA completed', { sessionId });
      }

      // ── Wait for app to settle and capture cookies ────────────────────────
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 15_000 }).catch(() => {});

      const rawCookies = await page.cookies();
      const cookies: SerializedCookie[] = rawCookies
        .filter((c) => c.domain.includes('airtable.com'))
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires ?? -1,
          httpOnly: c.httpOnly,
          secure: c.secure,
        }));

      if (cookies.length === 0) {
        throw new ScrapingError('Login succeeded but no Airtable cookies captured');
      }

      // ── Await secretSocketId (best-effort) ────────────────────────────────
      const secretSocketId = await socketIdPromise;
      if (!secretSocketId) {
        this.log.warn('secretSocketId not harvested during login — Phase 7 will attempt re-harvest', { sessionId });
      }

      const harvestedTokens: HarvestedTokens = { secretSocketId: secretSocketId ?? '' };

      await this.sessionRepository.updateTokens(sessionId, cookies, harvestedTokens);
      await this.sessionRepository.updateState(sessionId, 'active', new Date());

      this.log.info('Login complete', {
        sessionId,
        cookieCount: cookies.length,
        hasSocketId: Boolean(secretSocketId),
      });

      return { cookies, tokens: harvestedTokens };
    } catch (err) {
      this.log.error('Login failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.sessionRepository.updateState(sessionId, 'invalid').catch(() => {});
      throw err instanceof Error ? err : new ScrapingError(String(err));
    } finally {
      await page.close().catch(() => {});
      this.mfaWaiters.delete(sessionId);
    }
  }

  /** Checks whether the page is showing an MFA / OTP challenge after credentials. */
  private async detectMfa(page: Page): Promise<boolean> {
    try {
      const result = await Promise.race([
        page.waitForSelector(SEL.mfaInput, { timeout: 5_000 }).then(() => 'mfa' as const),
        page.waitForSelector(SEL.workspaceIndicator, { timeout: 5_000 }).then(() => 'done' as const),
        // Also accept a workspace URL as "done"
        page.waitForFunction(
          '() => window.location.pathname !== "/login"',
          { timeout: 5_000 },
        ).then(() => 'done' as const),
      ]);
      return result === 'mfa';
    } catch {
      return false;
    }
  }

  /** Returns a Promise that resolves when `submitMfaCode` is called, or rejects on timeout. */
  private awaitMfaCode(sessionId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.mfaWaiters.delete(sessionId);
        reject(new ScrapingError(`MFA code not submitted within ${MFA_TIMEOUT_MS / 1000}s`));
      }, MFA_TIMEOUT_MS);

      this.mfaWaiters.set(sessionId, {
        resolveWithCode: (code) => {
          clearTimeout(timer);
          this.mfaWaiters.delete(sessionId);
          resolve(code);
        },
        rejectWithError: (err) => {
          clearTimeout(timer);
          this.mfaWaiters.delete(sessionId);
          reject(err);
        },
      });
    });
  }

  // ── Session validation ──────────────────────────────────────────────────────

  private async validateWithSession(session: ScrapeSessionDocument): Promise<boolean> {
    if (!session.cookies.length) return false;

    // Quick cookie-expiry check — avoid an HTTP round-trip if cookies are stale.
    const nowSec = Date.now() / 1_000;
    const airtableCookies = session.cookies.filter((c) => c.domain.includes('airtable.com'));
    if (airtableCookies.length === 0) return false;

    const allExpired = airtableCookies
      .filter((c) => c.expires > 0) // skip session cookies (expires = -1)
      .every((c) => c.expires < nowSec);
    if (allExpired) return false;

    // HTTP probe — follow redirects and check final URL.
    const cookieHeader = session.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    try {
      const response = await fetch('https://airtable.com/', {
        headers: {
          Cookie: cookieHeader,
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok && !response.url.includes('/login');
    } catch {
      // Network failure — assume session is still valid to avoid unnecessary re-login.
      return true;
    }
  }
}

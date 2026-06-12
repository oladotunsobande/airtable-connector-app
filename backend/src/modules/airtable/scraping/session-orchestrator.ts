import crypto from "node:crypto";
import type { Page, HTTPRequest } from "puppeteer";
import type { AppConfig } from "../../../config/index.js";
import type { Logger } from "../../../core/logger/index.js";
import type { IBrowserManager } from "../../../infrastructure/browser/browser-manager.interface.js";
import type {
  IScrapeSessionRepository,
  ScrapeSessionDocument,
  SerializedCookie,
  HarvestedTokens,
} from "../models/scrape-session.repository.interface.js";
import type {
  ISessionOrchestrator,
  HarvestedSession,
  LoginStartResult,
} from "./session-orchestrator.interface.js";
import { ScrapingError } from "../../../core/errors/index.js";

// ── Airtable DOM selectors ────────────────────────────────────────────────────
const SEL = {
  emailInput: 'input[name="email"]',
  passwordInput: 'input[type="password"]',
  submitButton: 'button[type="submit"]',
  mfaInput:
    'input[autocomplete="one-time-code"], input[name="otpCode"], input[name="otp_attempt"]',
  mfaSubmit: 'button[type="submit"]',
  workspaceIndicator:
    '[data-testid="workspace-hub-page"], [data-testid="workspace-page"]',
} as const;

const AIRTABLE_LOGIN_URL = "https://airtable.com/login";
const SESSION_TTL_MS = 6 * 60 * 60 * 1_000; // 6 hours
const MFA_TIMEOUT_MS = 5 * 60 * 1_000;       // 5 minutes

interface MfaWaiter {
  resolveWithCode: (code: string) => void;
  rejectWithError: (err: Error) => void;
}

export class SessionOrchestrator implements ISessionOrchestrator {
  private loginPromise: Promise<HarvestedSession> | null = null;
  private readonly mfaWaiters = new Map<string, MfaWaiter>();
  // Kept open after login so workers can make authenticated fetches through it.
  private activePage: Page | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly browserManager: IBrowserManager,
    private readonly sessionRepository: IScrapeSessionRepository,
    private readonly log: Logger,
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Starts a login if needed.
   *
   * Waits until the MFA check point before returning so that callers receive
   * an accurate state: either "awaiting_mfa" (caller must collect and submit a
   * TOTP code then call start() again) or "active" (login is proceeding in the
   * background with no MFA required).
   */
  async startLogin(): Promise<LoginStartResult> {
    const existing = await this.sessionRepository.findActive();

    if (existing?.state === "awaiting_mfa") {
      return { sessionId: existing.sessionId, state: "awaiting_mfa" };
    }
    if (existing?.state === "active" && existing.harvestedTokens) {
      const valid = await this.validateWithSession(existing);
      if (valid) return { sessionId: existing.sessionId, state: "active" };
      await this.sessionRepository.updateState(existing.sessionId, "expired");
    }

    const sessionId = crypto.randomUUID();
    await this.sessionRepository.save({
      sessionId,
      cookies: [],
      harvestedTokens: null,
      state: "active",
      validatedAt: null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });

    if (!this.loginPromise) {
      // phase1 resolves as soon as we know whether MFA is needed.
      // performLogin() calls resolvePhase1 at that checkpoint.
      const { promise: phase1, resolve: resolvePhase1, reject: rejectPhase1 } =
        Promise.withResolvers<LoginStartResult>();

      this.loginPromise = this.performLogin(sessionId, resolvePhase1)
        .catch((err: unknown) => {
          // Reject phase1 if login fails before it signals (e.g. navigation error).
          rejectPhase1(err instanceof Error ? err : new Error(String(err)));
          throw err;
        })
        .finally(() => {
          this.loginPromise = null;
        });

      // Surface background login errors to the log without unhandled-rejection.
      this.loginPromise.catch((err: unknown) => {
        this.log.error("Background login failed", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return phase1; // block until MFA state is known
    }

    return { sessionId, state: "active" };
  }

  async getSession(): Promise<HarvestedSession> {
    const existing = await this.sessionRepository.findActive();

    if (existing) {
      if (existing.harvestedTokens) {
        const valid = await this.validateWithSession(existing);
        if (valid)
          return { cookies: existing.cookies, tokens: existing.harvestedTokens };
        await this.sessionRepository.updateState(existing.sessionId, "expired");
      } else if (!this.loginPromise) {
        await this.sessionRepository.updateState(existing.sessionId, "expired");
      }
    }

    if (this.loginPromise) return this.loginPromise;

    const sessionId = crypto.randomUUID();
    await this.sessionRepository.save({
      sessionId,
      cookies: [],
      harvestedTokens: null,
      state: "active",
      validatedAt: null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });

    const { resolve: resolvePhase1 } =
      Promise.withResolvers<LoginStartResult>();

    this.loginPromise = this.performLogin(sessionId, resolvePhase1).finally(() => {
      this.loginPromise = null;
    });

    return this.loginPromise;
  }

  /**
   * Waits for an in-progress login to fully complete (including post-MFA steps).
   * Used by ScrapeRunService after the user submits an MFA code.
   */
  async awaitLoginComplete(): Promise<HarvestedSession> {
    if (this.loginPromise) return this.loginPromise;

    const session = await this.sessionRepository.findActive();
    if (session?.state === "active" && session.harvestedTokens) {
      return { cookies: session.cookies, tokens: session.harvestedTokens };
    }

    throw new ScrapingError("No active session found after MFA submission");
  }

  async submitMfaCode(sessionId: string, code: string): Promise<void> {
    const waiter = this.mfaWaiters.get(sessionId);
    if (!waiter) {
      throw new ScrapingError(`No pending MFA flow for session '${sessionId}'`);
    }
    this.log.info("MFA code received", { sessionId });
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
      await this.sessionRepository.updateState(session.sessionId, "expired");
      this.log.info("Session invalidated", { sessionId: session.sessionId });
    }
    await this.closeActivePage();
  }

  /**
   * Makes a POST request from within the live Puppeteer browser so the
   * browser's own cookie store is used automatically.  This is the only
   * reliable way to call Airtable internal APIs — manual Node.js fetch with
   * copied cookies fails because Airtable validates the session differently
   * for server-originated requests.
   */
  async makeBrowserFetch(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; text: string }> {
    const page = await this.ensureActivePage();

    // page.evaluate() runs in the browser context; all cookies that the browser
    // holds for airtable.com are sent automatically via credentials:'include'.
    return (page.evaluate(
      async (reqUrl, reqBody, reqHeaders) => {
        const res = await fetch(reqUrl as string, {
          method: "POST",
          headers: {
            ...(reqHeaders as Record<string, string>),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: reqBody as string,
          credentials: "include",
        });
        return { status: res.status, text: await res.text() };
      },
      url,
      body,
      headers,
    ) as Promise<{ status: number; text: string }>);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Returns the active browser page, waiting for a login in progress if needed,
   * or reopening a page from saved session cookies if the page was closed.
   */
  private async ensureActivePage(): Promise<Page> {
    // If a login is in progress and the page isn't ready yet, wait for it.
    // This covers the no-MFA race where resolvePhase1 fires before activePage is set.
    if ((!this.activePage || this.activePage.isClosed()) && this.loginPromise) {
      await this.loginPromise.catch(() => {});
    }

    if (this.activePage && !this.activePage.isClosed()) {
      return this.activePage;
    }

    // Page is gone (crash, idle eviction, etc.) — try to reopen with saved cookies.
    this.activePage = null;
    const session = await this.sessionRepository.findActive();
    if (!session?.cookies.length) {
      throw new ScrapingError(
        "No active session — start a new scraping run to re-authenticate",
      );
    }

    const page = await this.browserManager.newPage();
    try {
      // page.setCookie() is deprecated in Puppeteer v22+; use the browser context instead.
      await page.browserContext().setCookie(
        ...session.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          httpOnly: c.httpOnly,
          secure: c.secure,
          ...(c.expires > 0 ? { expires: c.expires } : {}),
        })),
      );
      // Navigate to airtable.com so the browser context is established for the domain
      // before workers make fetch calls via page.evaluate().
      await page.goto("https://airtable.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      }).catch(() => {});
    } catch (err) {
      await page.close().catch(() => {});
      throw new ScrapingError(
        `Failed to restore browser session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.activePage = page;
    this.log.info("Browser session page reopened from saved cookies");
    return page;
  }

  private async closeActivePage(): Promise<void> {
    if (this.activePage) {
      await this.activePage.close().catch(() => {});
      this.activePage = null;
    }
  }

  // ── Puppeteer login flow ────────────────────────────────────────────────────

  /**
   * @param resolvePhase1  Called once MFA state is known — either
   *   { state: "awaiting_mfa" } or { state: "active" }.  The rest of the login
   *   (post-MFA navigation, cookie + socket-ID capture) continues in the
   *   background after this signal.
   */
  private async performLogin(
    sessionId: string,
    resolvePhase1: (result: LoginStartResult) => void,
  ): Promise<HarvestedSession> {
    // Close any previously-kept page before opening a new one.
    await this.closeActivePage();

    const page = await this.browserManager.newPage();
    this.log.info("Puppeteer login started", { sessionId });

    try {
      // ── Request interception: passively collect secretSocketId ────────────
      // We do NOT set a timer here.  The capture window opens freshly after
      // the workspace loads (post-MFA if applicable).
      let capturedSocketId: string | null = null;

      const onRequest = (req: HTTPRequest) => {
        const url = req.url();

        // Block consent-manager scripts that steal keyboard focus.
        if (url.includes("transcend.io") || url.includes("airgap.js")) {
          void req.abort().catch(() => {});
          return;
        }

        if (url.includes("readRowActivitiesAndComments") && !capturedSocketId) {
          // The frontend sends params in a POST body or query string.
          const body = req.postData() ?? "";
          const qs = url.includes("?")
            ? new URLSearchParams(url.split("?")[1] ?? "")
            : new URLSearchParams();

          const objStr =
            new URLSearchParams(body).get("stringifiedObjectParams") ??
            qs.get("stringifiedObjectParams");

          if (objStr) {
            try {
              const obj = JSON.parse(objStr) as Record<string, unknown>;
              if (typeof obj["secretSocketId"] === "string") {
                capturedSocketId = obj["secretSocketId"];
                this.log.debug("secretSocketId captured from intercepted request", {
                  sessionId,
                });
              }
            } catch {
              /* ignore parse errors */
            }
          }
        }

        void req.continue().catch(() => {});
      };

      await page.setRequestInterception(true);
      page.on("request", onRequest);

      // ── Navigate to login ─────────────────────────────────────────────────
      await page.goto(AIRTABLE_LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      // ── Step 1: email ─────────────────────────────────────────────────────
      await page.waitForSelector(SEL.emailInput, { timeout: 30_000 });
      this.log.debug("Email field found", { sessionId, url: page.url() });
      await page.click(SEL.emailInput);
      await page.type(SEL.emailInput, this.config.airtable.loginEmail, {
        delay: 40,
      });
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 })
          .catch(() => {}),
        page.click(SEL.submitButton),
      ]);
      this.log.debug("After email submit", { sessionId, url: page.url() });

      // ── Step 2: password ──────────────────────────────────────────────────
      await page.waitForSelector(SEL.passwordInput, { timeout: 30_000 });
      await page.type(SEL.passwordInput, this.config.airtable.loginPassword, {
        delay: 40,
      });
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 })
          .catch(() => {}),
        page.click(SEL.submitButton),
      ]);

      // ── MFA detection ─────────────────────────────────────────────────────
      const hasMfa = await this.detectMfa(page);

      if (hasMfa) {
        this.log.info("MFA challenge detected", { sessionId });
        await this.sessionRepository.updateState(sessionId, "awaiting_mfa");

        // Signal phase1 BEFORE blocking on user input so the caller can show
        // the MFA dialog to the user immediately.
        resolvePhase1({ sessionId, state: "awaiting_mfa" });

        const code = await this.awaitMfaCode(sessionId);

        await page.waitForSelector(SEL.mfaInput, { timeout: 10_000 });
        await page.type(SEL.mfaInput, code, { delay: 40 });
        await Promise.all([
          page
            .waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 })
            .catch(() => {}),
          page.click(SEL.mfaSubmit),
        ]);

        await this.sessionRepository.updateState(sessionId, "active");
        this.log.info("MFA completed", { sessionId });
      } else {
        // No MFA — signal phase1 immediately so the pipeline can start.
        resolvePhase1({ sessionId, state: "active" });
      }

      // ── Wait for the workspace to settle ──────────────────────────────────
      await page
        .waitForNetworkIdle({ idleTime: 1_000, timeout: 30_000 })
        .catch(() => {});

      // Tear down request interception before exposing the page to workers.
      // If activePage were set first, a worker could call makeBrowserFetch()
      // while interception is still enabled but the handler already removed,
      // leaving requests with no req.continue() call — they hang and the
      // browser reports "Failed to fetch".
      page.off("request", onRequest);
      await page.setRequestInterception(false).catch(() => {});

      // Store the page only after interception is fully disabled so workers
      // that call makeBrowserFetch() always see a clean, unintercepted page.
      this.activePage = page;

      // ── Capture cookies ───────────────────────────────────────────────────
      // page.cookies() is deprecated in Puppeteer v22+. Use a CDP session to
      // call Network.getAllCookies, which is stable and returns the full store.
      const cdp = await page.createCDPSession();
      let rawCookies: Array<{
        name: string; value: string; domain: string; path: string;
        expires: number; httpOnly: boolean; secure: boolean;
      }> = [];
      try {
        const result = await cdp.send('Network.getAllCookies') as {
          cookies: typeof rawCookies;
        };
        rawCookies = result.cookies;
      } finally {
        await cdp.detach().catch(() => {});
      }

      const cookies: SerializedCookie[] = rawCookies
        .filter((c) => c.domain.includes("airtable.com"))
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
        throw new ScrapingError(
          "Login succeeded but no Airtable cookies captured",
        );
      }

      const harvestedTokens: HarvestedTokens = {
        secretSocketId: capturedSocketId ?? "",
      };

      await this.sessionRepository.updateTokens(
        sessionId,
        cookies,
        harvestedTokens,
      );
      await this.sessionRepository.updateState(sessionId, "active", new Date());

      this.log.info("Login complete", {
        sessionId,
        cookieCount: cookies.length,
        hasSocketId: Boolean(capturedSocketId),
      });

      return { cookies, tokens: harvestedTokens };
    } catch (err) {
      // If activePage was set to this page during the early assignment
      // (post-workspace-load), null it out so workers don't try to use a
      // page that is about to be closed.
      if (this.activePage === page) {
        this.activePage = null;
      }
      const screenshotPath = `/tmp/login-fail-${sessionId.slice(0, 8)}.png`;
      await page
        .screenshot({ path: screenshotPath, fullPage: false })
        .catch(() => {});
      this.log.error("Login failed", {
        sessionId,
        url: page.url(),
        screenshot: screenshotPath,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.sessionRepository
        .updateState(sessionId, "invalid")
        .catch(() => {});
      await page.close().catch(() => {}); // only close on failure
      throw err instanceof Error ? err : new ScrapingError(String(err));
    } finally {
      // NOTE: do NOT close the page here — on success it is stored as
      // activePage and will be closed by invalidateSession() or the next login.
      this.mfaWaiters.delete(sessionId);
    }
  }

  private async detectMfa(page: Page): Promise<boolean> {
    try {
      const result = await Promise.race([
        page
          .waitForSelector(SEL.mfaInput, { timeout: 5_000 })
          .then(() => "mfa" as const),
        page
          .waitForSelector(SEL.workspaceIndicator, { timeout: 5_000 })
          .then(() => "done" as const),
        page
          .waitForFunction('() => window.location.pathname !== "/login"', {
            timeout: 5_000,
          })
          .then(() => "done" as const),
      ]);
      return result === "mfa";
    } catch {
      return false;
    }
  }

  private awaitMfaCode(sessionId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.mfaWaiters.delete(sessionId);
        reject(
          new ScrapingError(
            `MFA code not submitted within ${MFA_TIMEOUT_MS / 1000}s`,
          ),
        );
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

  private async validateWithSession(
    session: ScrapeSessionDocument,
  ): Promise<boolean> {
    if (!session.cookies.length) return false;

    const nowSec = Date.now() / 1_000;
    const airtableCookies = session.cookies.filter((c) =>
      c.domain.includes("airtable.com"),
    );
    if (airtableCookies.length === 0) return false;

    const allExpired = airtableCookies
      .filter((c) => c.expires > 0)
      .every((c) => c.expires < nowSec);
    if (allExpired) return false;

    const cookieHeader = session.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    try {
      const response = await fetch("https://airtable.com/", {
        headers: {
          Cookie: cookieHeader,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok && !response.url.includes("/login");
    } catch {
      return true;
    }
  }
}

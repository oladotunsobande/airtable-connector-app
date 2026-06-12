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
import { ScrapingError, SessionExpiredError } from "../../../core/errors/index.js";

// ── Airtable DOM selectors ────────────────────────────────────────────────────
const SEL = {
  emailInput: 'input[name="email"]',
  passwordInput: 'input[type="password"]',
  submitButton: 'button[type="submit"]',
  // Covers legacy MFA page selectors and Airtable's newer /2fa/... page.
  // The /2fa/ page renders a single input with placeholder "6-digit code" —
  // it carries none of the old name/autocomplete/inputmode attributes, so
  // input[placeholder*="digit"] is needed to match it.
  mfaInput:
    'input[autocomplete="one-time-code"], input[name="otpCode"], input[name="otp_attempt"], input[inputmode="numeric"], input[type="text"][maxlength="6"], input[placeholder*="digit"]',
  // The /2fa/ page renders <button>Submit</button> with no explicit type
  // attribute. CSS [type="submit"] only matches when the attribute is present
  // in the DOM, so we also include button:not([type]) to cover typeless buttons.
  mfaSubmit: 'button[type="submit"], button:not([type])',
  workspaceIndicator:
    '[data-testid="workspace-hub-page"], [data-testid="workspace-page"]',
} as const;

const AIRTABLE_LOGIN_URL = "https://airtable.com/login";
const SESSION_TTL_MS = 6 * 60 * 60 * 1_000; // 6 hours
const MFA_TIMEOUT_MS = 5 * 60 * 1_000;       // 5 minutes
// Airtable's internal service JWTs are short-lived (typically 5–15 minutes).
// Re-navigate to the base page before this threshold elapses so we capture a
// fresh Authorization header before the old one becomes stale.
const AUTH_HEADER_TTL_MS = 4 * 60 * 1_000;   // 4 minutes

interface MfaWaiter {
  resolveWithCode: (code: string) => void;
  rejectWithError: (err: Error) => void;
}

export class SessionOrchestrator implements ISessionOrchestrator {
  private loginPromise: Promise<HarvestedSession> | null = null;
  // Holds a reference to the same login Promise BEFORE .finally() clears
  // loginPromise to null. When loginPromise rejects and is cleared, awaitLoginComplete()
  // can still await lastLoginAttempt to surface the real error instead of
  // throwing "No active session found after MFA submission".
  private lastLoginAttempt: Promise<HarvestedSession> | null = null;
  private readonly mfaWaiters = new Map<string, MfaWaiter>();
  // Kept open after login so workers can make authenticated fetches through it.
  private activePage: Page | null = null;
  // Authorization header captured from Airtable's own internal API requests
  // (observed via CDP Network events or request interception). Airtable keeps
  // this token only in memory; we can't extract it from cookies, localStorage,
  // or window globals — the only way to get it is to watch what the browser
  // sends when the app is running. Cleared on session invalidation.
  private capturedAuthHeader: string | null = null;
  // Unix-ms timestamp of the last successful capturedAuthHeader capture.
  // Used to decide whether a re-navigation is needed to refresh the JWT.
  private capturedAuthHeaderAt: number = 0;
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

      // Keep the base promise (before .finally) so awaitLoginComplete() can
      // still surface the real rejection reason after .finally clears loginPromise.
      const basePromise = this.performLogin(sessionId, resolvePhase1)
        .catch((err: unknown) => {
          // Reject phase1 if login fails before it signals (e.g. navigation error).
          rejectPhase1(err instanceof Error ? err : new Error(String(err)));
          throw err;
        });

      this.lastLoginAttempt = basePromise;

      this.loginPromise = basePromise.finally(() => {
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

    // Return tokens from the established Puppeteer session without re-validating
    // via Node.js HTTP fetch. validateWithSession() uses a plain Node.js fetch
    // whose User-Agent and cookie handling differ from the browser context —
    // Airtable frequently redirects it to /login even for live sessions. Marking
    // the session expired here causes ensureActivePage()'s cookie-restore path to
    // fail ("No active session") because findActive() then returns null. The
    // 401/403 handler in revision-history.service.ts is the correct place to
    // detect a genuinely expired session; let it do that job instead.
    if (existing?.harvestedTokens) {
      return { cookies: existing.cookies, tokens: existing.harvestedTokens };
    }

    if (this.loginPromise) return this.loginPromise;

    // No active session and no login in progress. Workers must not start their
    // own login flow — that races with startLogin() and prevents the MFA event
    // from reaching the frontend (the phase1 resolvePhase1 callback would be
    // called inside the worker's chain, where nobody is listening for it).
    // Throw so BullMQ retries the job after the user-initiated login completes.
    throw new SessionExpiredError();
  }

  /**
   * Waits for an in-progress login to fully complete (including post-MFA steps).
   * Used by ScrapeRunService after the user submits an MFA code.
   */
  async awaitLoginComplete(): Promise<HarvestedSession> {
    // loginPromise is still running — attach to it directly.
    if (this.loginPromise) return this.loginPromise;

    // loginPromise was cleared by .finally() after settling. Await the base
    // promise so the real rejection error surfaces (e.g. "no cookies captured"),
    // rather than masking it with "No active session found after MFA submission".
    if (this.lastLoginAttempt) {
      const p = this.lastLoginAttempt;
      this.lastLoginAttempt = null;
      return p;
    }

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
    this.capturedAuthHeader = null;
    this.capturedAuthHeaderAt = 0;
    const session = await this.sessionRepository.findActive();
    if (session) {
      await this.sessionRepository.updateState(session.sessionId, "expired");
      this.log.info("Session invalidated", { sessionId: session.sessionId });
    }
    await this.closeActivePage();
  }

  /**
   * Makes an authenticated request from within the live Puppeteer browser so
   * the browser's own cookie store is used automatically.  This is the only
   * reliable way to call Airtable internal APIs — manual Node.js fetch with
   * copied cookies fails because Airtable validates the session differently
   * for server-originated requests.
   *
   * `method` defaults to "POST". Use "GET" for Airtable's v0.3 read endpoints
   * (e.g. readRowActivitiesAndComments) — they authenticate via cookies only
   * and must not carry a request body or Content-Type header.
   */
  async makeBrowserFetch(
    url: string,
    body: string,
    headers: Record<string, string>,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<{ status: number; text: string }> {
    const page = await this.ensureActivePage();

    // The fetch must run from an authenticated airtable.com page. Guard against
    // two failure modes:
    //  1. Page is not on airtable.com at all (e.g. about:blank after cookie restore).
    //  2. Page is on airtable.com but at an auth/login screen (session dropped).
    //     Login pages pass the first domain check but lack the workspace auth
    //     context needed for internal API calls.
    const pageUrl = page.url();
    this.log.debug("makeBrowserFetch: page URL before fetch", { pageUrl, targetUrl: url });
    const needsNav =
      !pageUrl.includes("airtable.com") ||
      pageUrl.includes("/login") ||
      pageUrl.includes("/2fa") ||
      pageUrl.includes("/signup");

    if (needsNav) {
      this.log.warn("Active page needs navigation before fetch", { pageUrl });
      await page
        .goto("https://airtable.com/", { waitUntil: "networkidle2", timeout: 60_000 })
        .catch(() => {});
      this.log.debug("makeBrowserFetch: page URL after navigation", { pageUrl: page.url() });
    }

    // Airtable's v0.3 GET endpoints authenticate via cookies only — sending a
    // stale or mismatched Authorization header on a GET request causes
    // INVALID_AUTH_TOKEN even when the session cookie is valid.
    // Only pre-merge the captured Bearer token for POST requests.
    const mergedHeaders: Record<string, string> =
      method === 'POST' && this.capturedAuthHeader
        ? { ...headers, Authorization: this.capturedAuthHeader }
        : { ...headers };

    // Isolated helper so we can retry on Target-closed without duplicating the evaluate block.
    const runEvaluate = (p: Page) =>
      p.evaluate(
        // page.evaluate() runs in the page's JavaScript context.
        // All logic is inlined — no named inner functions — because tsx (esbuild)
        // wraps named function expressions with __name(fn, "name") to preserve
        // .name. Puppeteer serialises the callback via toString() which includes
        // the __name() calls, but the module-level __name helper is NOT included
        // in the serialised string. Chrome then throws "__name is not defined".
        //
        // Strategy: extract Airtable's own auth tokens from the live page so the
        // request carries the same credentials their frontend sends:
        //  A) XSRF double-submit cookie — Airtable sets a non-httpOnly XSRF-TOKEN
        //     cookie; their JS echoes it as X-XSRF-TOKEN on every mutating request.
        //  B) Service JWT — Airtable embeds a short-lived JWT in page bootstrap
        //     data; if found it goes in Authorization: Bearer <jwt>.
        //     (Not used for GET — those endpoints authenticate via cookies only.)
        async (reqUrl, reqBody, reqHeaders, reqMethod) => {
          type AnyObj = Record<string, unknown>;
          type ScriptEl = { textContent: string | null };
          type DocLike = {
            cookie: string;
            querySelectorAll(s: string): ArrayLike<ScriptEl>;
          };
          type StorageLike = {
            length: number;
            key(n: number): string | null;
            getItem(k: string): string | null;
          };
          const doc = (globalThis as unknown as { document: DocLike }).document;
          const ls = (globalThis as unknown as { localStorage: StorageLike }).localStorage;

          // ── A: XSRF/CSRF token from document.cookie (inline, no named fn) ────
          let csrfToken: string | null = null;
          for (const cookiePair of doc.cookie.split(";")) {
            const eqIdx = cookiePair.indexOf("=");
            if (eqIdx === -1) continue;
            if (/xsrf|csrf/i.test(cookiePair.slice(0, eqIdx).trim())) {
              csrfToken = decodeURIComponent(cookiePair.slice(eqIdx + 1).trim());
              break;
            }
          }

          // ── B: service JWT from page bootstrap data (inline, no named fn) ────
          let serviceJWT: string | null = null;
          jwtSearch: {
            const w = globalThis as unknown as AnyObj;
            // Check known window globals
            for (const gKey of ["__appBootstrapData", "__pageLoadData", "__bootstrap", "pageLoadData", "airtableBootstrapData", "__initData"]) {
              const gObj = w[gKey] as AnyObj | undefined;
              if (gObj && typeof gObj === "object") {
                for (const gProp of Object.keys(gObj)) {
                  const gVal = gObj[gProp];
                  if (/token|jwt|session/i.test(gProp) && typeof gVal === "string" && gVal.split(".").length === 3 && gVal.length > 40) {
                    serviceJWT = gVal;
                    break jwtSearch;
                  }
                }
              }
            }
            // Check JSON script tags
            for (const scriptEl of Array.from(doc.querySelectorAll('script[type="application/json"]'))) {
              try {
                const scriptData = JSON.parse(scriptEl.textContent ?? "") as AnyObj;
                for (const sProp of Object.keys(scriptData)) {
                  const sVal = scriptData[sProp];
                  if (/token|jwt|session/i.test(sProp) && typeof sVal === "string" && sVal.split(".").length === 3 && sVal.length > 40) {
                    serviceJWT = sVal;
                    break jwtSearch;
                  }
                }
              } catch { /* skip non-JSON */ }
            }
            // Check localStorage
            try {
              for (let lsIdx = 0; lsIdx < ls.length; lsIdx++) {
                const lsKey = ls.key(lsIdx) ?? "";
                if (/token|jwt|auth/i.test(lsKey)) {
                  const lsVal = ls.getItem(lsKey);
                  if (typeof lsVal === "string" && lsVal.split(".").length === 3 && lsVal.length > 40) {
                    serviceJWT = lsVal;
                    break jwtSearch;
                  }
                }
              }
            } catch { /* localStorage unavailable */ }
          }

          const extraHeaders: Record<string, string> = {};
          if (csrfToken) {
            extraHeaders["X-XSRF-TOKEN"] = csrfToken;
            extraHeaders["X-Airtable-CSRF-Token"] = csrfToken;
          }
          // Service JWT only applies to POST requests. Airtable's v0.3 GET
          // endpoints authenticate via cookies; injecting a stale Bearer token
          // on a GET request causes INVALID_AUTH_TOKEN.
          if ((reqMethod as string) !== "GET" && serviceJWT && !(reqHeaders as Record<string, string>)["Authorization"]) {
            extraHeaders["Authorization"] = `Bearer ${serviceJWT}`;
          }

          const allHeaders: Record<string, string> = {
            ...(reqHeaders as Record<string, string>),
            ...extraHeaders,
          };
          if ((reqMethod as string) !== "GET") {
            allHeaders["Content-Type"] = "application/x-www-form-urlencoded";
          }

          const res = await fetch(reqUrl as string, {
            method: reqMethod as string,
            headers: allHeaders,
            body: (reqMethod as string) !== "GET" ? reqBody as string : undefined,
            credentials: "include",
          } as RequestInit);

          return {
            status: res.status,
            text: await res.text(),
            _debug: { csrfFound: Boolean(csrfToken), jwtFound: Boolean(serviceJWT) },
          };
        },
        url,
        body,
        mergedHeaders,
        method,
      ) as Promise<{ status: number; text: string; _debug?: { csrfFound: boolean; jwtFound: boolean } }>;

    try {
      const result = await runEvaluate(page);
      if (result._debug) {
        this.log.debug("makeBrowserFetch: auth tokens in page context", result._debug);
      }
      return { status: result.status, text: result.text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "Target closed" means the CDP target was closed while the evaluate was
      // in flight (e.g. another worker triggered invalidateSession). Clear the
      // stale reference and retry once after ensureActivePage() restores from
      // saved cookies. If the session is genuinely expired the retry returns
      // 401/403 and the caller's existing handler deals with it.
      if (msg.includes("Target closed") || msg.includes("Session closed")) {
        if (this.activePage === page) this.activePage = null;
        const retryResult = await runEvaluate(await this.ensureActivePage());
        return { status: retryResult.status, text: retryResult.text };
      }
      throw err;
    }
  }

  /**
   * Navigates the active Puppeteer page to the given URL.
   * Used by services that need the page to be in a specific auth context
   * (e.g. a particular Airtable base) before making internal API calls.
   *
   * Attaches a CDP Network monitor for the duration of the navigation.
   * When Airtable's frontend makes internal API calls during page load it
   * includes an Authorization header that we cannot read from cookies,
   * localStorage, or window globals (it lives only in memory). Observing
   * those outgoing requests via CDP is the only reliable way to capture it.
   */
  async navigateActivePage(url: string): Promise<void> {
    const page = await this.ensureActivePage();
    const current = page.url();

    // Skip navigation only when the page is already at the target URL *and*
    // the captured auth header is still fresh. If the header is absent or older
    // than AUTH_HEADER_TTL_MS, we must re-navigate so Airtable's app fires its
    // internal /v0.3/ requests, letting us capture a new JWT. Without this,
    // every row after the first reuses the same stale token and Airtable returns
    // INVALID_AUTH_TOKEN once it expires.
    const alreadyThere = current === url || current.startsWith(url);
    const authIsFresh =
      this.capturedAuthHeader !== null &&
      Date.now() - this.capturedAuthHeaderAt < AUTH_HEADER_TTL_MS;
    if (alreadyThere && authIsFresh) return;

    this.log.debug("navigateActivePage", {
      from: current,
      to: url,
      reason: alreadyThere ? "auth-header-stale" : "wrong-page",
    });

    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");

    cdp.on(
      "Network.requestWillBeSent",
      (params: { request: { url: string; headers: Record<string, string> } }) => {
        const reqUrl = params.request.url;
        if (!reqUrl.includes("/v0.3/") && !reqUrl.includes("/v0.4/")) return;
        const auth =
          params.request.headers["authorization"] ??
          params.request.headers["Authorization"];
        if (auth) {
          // Always overwrite — a newer JWT is always preferable to an older one.
          this.capturedAuthHeader = auth;
          this.capturedAuthHeaderAt = Date.now();
          this.log.debug("Captured auth header from navigation request", { reqUrl });
        }
      },
    );

    await page
      .goto(url, { waitUntil: "networkidle2", timeout: 60_000 })
      .catch(() => {});

    await cdp.detach().catch(() => {});
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
      const ctx = this.activePage.browserContext();
      await this.activePage.close().catch(() => {});
      // Always close the isolated context created by browserManager.newPage().
      await ctx.close().catch(() => {});
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
    // Clear auth header captured from the previous session so we don't replay
    // a stale token on behalf of a new login.
    this.capturedAuthHeader = null;
    this.capturedAuthHeaderAt = 0;

    const page = await this.browserManager.newPage();
    this.log.info("Puppeteer login started", { sessionId });

    try {
      let capturedSocketId: string | null = null;

      // ── WebSocket monitoring: capture secretSocketId (Pusher socket ID) ───
      // Airtable's frontend sends secretSocketId in readRowActivitiesAndComments
      // requests, but those requests only fire when a user opens a row activity
      // pane — never during automated login. Instead, intercept the Pusher
      // connection_established WebSocket frame, which fires on every page load.
      const cdpForWs = await page.createCDPSession();
      await cdpForWs.send("Network.enable");
      cdpForWs.on(
        "Network.webSocketFrameReceived",
        (params: { response: { payloadData: string } }) => {
          const payload = params.response.payloadData;
          if (capturedSocketId) return;
          try {
            const msg = JSON.parse(payload) as Record<string, unknown>;
            // Pusher sends: {"event":"pusher:connection_established","data":"{\"socket_id\":\"...\"}"}
            if (
              msg["event"] === "pusher:connection_established" &&
              typeof msg["data"] === "string"
            ) {
              const data = JSON.parse(msg["data"]) as Record<string, unknown>;
              if (typeof data["socket_id"] === "string") {
                capturedSocketId = data["socket_id"];
                this.log.debug("secretSocketId captured from WebSocket", {
                  sessionId,
                });
              }
            }
          } catch {
            /* ignore parse errors */
          }
        },
      );

      // ── Request interception: fallback capture + consent-manager blocking ─
      const onRequest = (req: HTTPRequest) => {
        const url = req.url();

        // Block consent-manager scripts that steal keyboard focus.
        if (url.includes("transcend.io") || url.includes("airgap.js")) {
          void req.abort().catch(() => {});
          return;
        }

        // Capture the Authorization header from any Airtable internal API call
        // made during the login/workspace-load phase. Airtable keeps this token
        // only in memory — observing outgoing requests is the only reliable way
        // to get it. We replay it on our own makeBrowserFetch() calls.
        if (url.includes("/v0.3/") || url.includes("/v0.4/")) {
          const headers = req.headers() as Record<string, string>;
          const auth = headers["authorization"] ?? headers["Authorization"];
          if (auth) {
            this.capturedAuthHeader = auth;
            this.capturedAuthHeaderAt = Date.now();
            this.log.debug("Captured auth header from intercepted login request", {
              sessionId,
              url,
            });
          }
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

        // Log the submit button's actual HTML attributes so selector mismatches
        // are immediately diagnosable in future failures.
        // Use globalThis["document"] to avoid the missing dom lib in tsconfig.
        const submitBtnAttrs = await page.evaluate((mfaInputSel) => {
          type AnyEl = {
            tagName: string; id: string; className: string;
            textContent: string | null;
            getAttribute(n: string): string | null;
            querySelector(s: string): AnyEl | null;
            closest(s: string): AnyEl | null;
          };
          type DocLike = { querySelector(s: string): AnyEl | null };
          const d = (globalThis as unknown as { document: DocLike }).document;
          const input = d.querySelector(mfaInputSel as string);
          const form = input?.closest("form");
          const btn = (form ?? d).querySelector("button, input[type='submit']");
          if (!btn) return null;
          return {
            tag: btn.tagName,
            type: btn.getAttribute("type"),
            text: btn.textContent?.trim().slice(0, 40) ?? null,
            id: btn.id,
            className: btn.className.slice(0, 80),
          };
        }, SEL.mfaInput);
        this.log.debug("MFA submit button attributes", { sessionId, submitBtnAttrs });

        // Press Enter on the focused input rather than clicking the submit
        // button by CSS selector. The button's type attribute varies across
        // Airtable's login page versions, making selector-based clicks fragile.
        // After page.type() the input retains focus, so Enter reliably submits
        // the form regardless of button markup.
        await Promise.all([
          page
            .waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 })
            .catch(() => {}),
          page.keyboard.press("Enter"),
        ]);

        // Verify the page actually navigated away from the MFA/login pages.
        // If the MFA code was wrong, Airtable stays on /2fa/ or /login and
        // shows an error — without this check, the flow silently continues to
        // cookie capture which then finds 0 cookies and throws a confusing error.
        const postMfaUrl = page.url();
        this.log.info("After MFA submission", { sessionId, postMfaUrl });
        if (postMfaUrl.includes("/2fa") || postMfaUrl.includes("/login")) {
          throw new ScrapingError(
            `MFA submission failed — page did not leave the authentication screen (still at ${postMfaUrl}). ` +
            "The MFA code may have been incorrect or expired.",
          );
        }

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

      // Fallback: if the WebSocket frame arrived before CDP was ready, try to
      // read the Pusher socket ID from the browser's window globals.
      if (!capturedSocketId) {
        capturedSocketId = await page
          .evaluate((): string | null => {
            type AnyObj = Record<string, unknown>;
            const w = globalThis as unknown as AnyObj;
            for (const key of ["_pusher", "pusher", "Pusher"]) {
              const p = w[key] as AnyObj | undefined;
              const sid = (p?.["connection"] as AnyObj | undefined)?.["socket_id"];
              if (typeof sid === "string" && sid) return sid;
            }
            return null;
          })
          .catch(() => null);
        if (capturedSocketId) {
          this.log.debug("secretSocketId captured from window globals", {
            sessionId,
          });
        }
      }

      // Broader socket ID scan: walk all window properties for any object with
      // a socket_id / socketId / secretSocketId string field.
      if (!capturedSocketId) {
        capturedSocketId = await page
          .evaluate((): string | null => {
            type AnyObj = Record<string, unknown>;
            const probe = (obj: unknown, depth: number): string | null => {
              if (depth > 3 || !obj || typeof obj !== "object") return null;
              const o = obj as AnyObj;
              for (const key of ["socket_id", "socketId", "secretSocketId", "id"]) {
                const v = o[key];
                if (typeof v === "string" && v.includes(".")) return v;
              }
              for (const key of Object.keys(o).slice(0, 20)) {
                const result = probe(o[key], depth + 1);
                if (result) return result;
              }
              return null;
            };
            const w = globalThis as unknown as AnyObj;
            for (const key of Object.getOwnPropertyNames(w).slice(0, 200)) {
              if (!/socket|pusher|realtime|ws|channel/i.test(key)) continue;
              const result = probe(w[key], 0);
              if (result) return result;
            }
            return null;
          })
          .catch(() => null);
        if (capturedSocketId) {
          this.log.debug("secretSocketId captured from deep window scan", {
            sessionId,
          });
        }
      }

      await cdpForWs.detach().catch(() => {});

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
      const failCtx = page.browserContext();
      await page.close().catch(() => {});
      await failCtx.close().catch(() => {});
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
        // Legacy inline MFA input on the login page
        page
          .waitForSelector(SEL.mfaInput, { timeout: 5_000 })
          .then(() => "mfa" as const),
        // Airtable's newer dedicated 2FA page (/2fa/<token>)
        page
          .waitForFunction(
            '() => window.location.pathname.startsWith("/2fa")',
            { timeout: 5_000 },
          )
          .then(() => "mfa" as const),
        page
          .waitForSelector(SEL.workspaceIndicator, { timeout: 5_000 })
          .then(() => "done" as const),
        // Only treat "not /login and not /2fa" as authenticated
        page
          .waitForFunction(
            '() => { const p = window.location.pathname; return p !== "/login" && !p.startsWith("/2fa"); }',
            { timeout: 5_000 },
          )
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

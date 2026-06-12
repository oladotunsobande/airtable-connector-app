import http from 'node:http';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../core/logger/index.js';
import { AppError } from '../core/errors/index.js';
import type { IOAuthService } from '../modules/airtable/auth/oauth.service.interface.js';
import type { ITokenProvider } from '../modules/airtable/auth/token-provider.interface.js';
import type { ITokenRepository } from '../modules/airtable/auth/token.repository.interface.js';
import type { ISessionOrchestrator } from '../modules/airtable/scraping/session-orchestrator.interface.js';

export interface HttpServerDeps {
  config: AppConfig;
  oauthService: IOAuthService;
  tokenProvider: ITokenProvider;
  tokenRepository: ITokenRepository;
  /** Phase 6+: optional so Phase 3 tests remain unaffected. */
  sessionOrchestrator?: ISessionOrchestrator;
  log: Logger;
}

/**
 * In-memory store for the OAuth PKCE code verifier + state while the user
 * is redirected to Airtable and back. Single-server only — fine for this app.
 * Entries expire after 10 minutes to avoid memory leaks.
 */
interface PendingAuth {
  codeVerifier: string;
  state: string;
  expiresAt: number;
}

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export class HttpServer {
  private readonly app: Express;
  private server: http.Server | null = null;
  private readonly pendingAuth = new Map<string, PendingAuth>();

  constructor(private readonly deps: HttpServerDeps) {
    this.app = express();
    this.app.use(express.json());
    this.app.use(this.cors.bind(this));
    this.registerRoutes();
    this.app.use(this.errorHandler.bind(this));
  }

  // ── CORS ──────────────────────────────────────────────────────────────────

  private cors(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:4200');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  }

  // ── Route registration ────────────────────────────────────────────────────

  private registerRoutes(): void {
    this.registerAuthRoutes();
    this.registerScrapingRoutes();
  }

  // ── Auth routes ───────────────────────────────────────────────────────────

  private registerAuthRoutes(): void {
    /**
     * GET /auth/airtable/start
     * Generates a PKCE code verifier + state, stores them, and redirects the
     * user to Airtable's OAuth consent page.
     */
    this.app.get('/auth/airtable/start', (_req: Request, res: Response) => {
      // Purge stale pending entries on each new attempt.
      this.purgeStalePendingAuth();

      const { url, codeVerifier, state } = this.deps.oauthService.buildAuthorizationUrl();

      this.pendingAuth.set(state, {
        codeVerifier,
        state,
        expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
      });

      this.deps.log.info('OAuth flow started', { state });
      res.redirect(url);
    });

    /**
     * GET /auth/airtable/callback
     * Receives the authorization code from Airtable, exchanges it for tokens,
     * persists them, then redirects the user back to the frontend.
     */
    this.app.get(
      '/auth/airtable/callback',
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { code, state: receivedState, error, error_description } = req.query as Record<string, string | undefined>;

          if (error) {
            this.deps.log.warn('OAuth callback error from Airtable', { error, error_description });
            res.redirect(`http://localhost:4200/integrations?error=${encodeURIComponent(error ?? 'unknown')}`);
            return;
          }

          if (!code || !receivedState) {
            res.status(400).json({ error: 'Missing code or state parameter' });
            return;
          }

          const pending = this.pendingAuth.get(receivedState);
          if (!pending || pending.expiresAt < Date.now()) {
            res.status(400).json({ error: 'Invalid or expired OAuth state' });
            return;
          }

          this.pendingAuth.delete(receivedState);

          const tokenSet = await this.deps.oauthService.exchangeCode(
            code,
            pending.codeVerifier,
            pending.state,
            receivedState,
          );

          await this.deps.tokenRepository.save(tokenSet);
          this.deps.log.info('OAuth tokens stored', { scope: tokenSet.scope });

          res.redirect('http://localhost:4200/integrations?connected=true');
        } catch (err) {
          next(err);
        }
      },
    );

    /**
     * GET /auth/status
     * Returns whether a valid OAuth token is currently stored.
     */
    this.app.get('/auth/status', async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const connected = await this.deps.tokenProvider.isConnected();
        res.json({ connected });
      } catch (err) {
        next(err);
      }
    });

    /**
     * DELETE /auth/airtable/disconnect
     * Removes the stored tokens, requiring re-authentication.
     */
    this.app.delete(
      '/auth/airtable/disconnect',
      async (_req: Request, res: Response, next: NextFunction) => {
        try {
          await this.deps.tokenRepository.delete();
          this.deps.log.info('OAuth tokens removed');
          res.json({ disconnected: true });
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // ── Scraping routes ───────────────────────────────────────────────────────

  private registerScrapingRoutes(): void {
    const orchestrator = this.deps.sessionOrchestrator;

    /**
     * POST /scraping/start
     * Initiates a Puppeteer login if no valid session exists.
     * Returns immediately with { sessionId, state }; the login runs in the
     * background. Poll GET /scraping/session to track progress.
     */
    this.app.post(
      '/scraping/start',
      async (_req: Request, res: Response, next: NextFunction) => {
        if (!orchestrator) {
          res.status(503).json({ error: 'SCRAPING_UNAVAILABLE', message: 'Scraping service not configured' });
          return;
        }
        try {
          const result = await orchestrator.startLogin();
          res.json(result);
        } catch (err) {
          next(err);
        }
      },
    );

    /**
     * GET /scraping/session
     * Returns the current scrape session state (for polling after /scraping/start).
     */
    this.app.get(
      '/scraping/session',
      async (_req: Request, res: Response, next: NextFunction) => {
        if (!orchestrator) {
          res.json({ sessionId: null, state: null, hasCookies: false, validatedAt: null });
          return;
        }
        try {
          const session = await orchestrator.getSessionState();
          res.json({
            sessionId: session?.sessionId ?? null,
            state: session?.state ?? null,
            hasCookies: (session?.cookies.length ?? 0) > 0,
            validatedAt: session?.validatedAt?.toISOString() ?? null,
          });
        } catch (err) {
          next(err);
        }
      },
    );

    /**
     * POST /scraping/mfa
     * Body: { sessionId: string, code: string }
     * Feeds a TOTP code into the paused Puppeteer login flow.
     */
    this.app.post(
      '/scraping/mfa',
      async (req: Request, res: Response, next: NextFunction) => {
        if (!orchestrator) {
          res.status(503).json({ error: 'SCRAPING_UNAVAILABLE', message: 'Scraping service not configured' });
          return;
        }
        try {
          const { sessionId, code } = req.body as { sessionId?: string; code?: string };
          if (!sessionId || !code) {
            res.status(400).json({ error: 'BAD_REQUEST', message: 'sessionId and code are required' });
            return;
          }
          await orchestrator.submitMfaCode(sessionId, code);
          res.status(204).send();
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // ── Error handler ─────────────────────────────────────────────────────────

  private errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
    if (err instanceof AppError) {
      this.deps.log.warn('Application error', { code: err.code, message: err.message });
      res.status(err.statusCode).json({ error: err.code, message: err.message });
      return;
    }

    const message = err instanceof Error ? err.message : 'Internal server error';
    this.deps.log.error('Unhandled error', {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    res.status(500).json({ error: 'INTERNAL_ERROR', message });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.deps.config.port, () => {
        this.deps.log.info('HTTP server listening', { port: this.deps.config.port });
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) { resolve(); return; }
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** Expose the Express app for testing. */
  getApp(): Express {
    return this.app;
  }

  private purgeStalePendingAuth(): void {
    const now = Date.now();
    for (const [key, entry] of this.pendingAuth) {
      if (entry.expiresAt < now) this.pendingAuth.delete(key);
    }
  }
}

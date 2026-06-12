import http from "node:http";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../core/logger/index.js";
import { AppError } from "../core/errors/index.js";
import type { IOAuthService } from "../modules/airtable/auth/oauth.service.interface.js";
import type { ITokenProvider } from "../modules/airtable/auth/token-provider.interface.js";
import type { ITokenRepository } from "../modules/airtable/auth/token.repository.interface.js";
import type { ISessionOrchestrator } from "../modules/airtable/scraping/session-orchestrator.interface.js";
import type { ScrapeRunService } from "../modules/airtable/pipeline/scrape-run.service.js";
import type {
  IEntitiesService,
  FilterOp,
} from "./entities/entities.service.interface.js";
import { KNOWN_ENTITIES } from "./entities/entities.service.js";

export interface HttpServerDeps {
  config: AppConfig;
  oauthService: IOAuthService;
  tokenProvider: ITokenProvider;
  tokenRepository: ITokenRepository;
  /** Phase 6+: optional so Phase 3 tests remain unaffected. */
  sessionOrchestrator?: ISessionOrchestrator;
  /** Scrape-run lifecycle + SSE streaming. */
  scrapeRunService?: ScrapeRunService;
  /** Phase 8+: optional so earlier tests remain unaffected. */
  entitiesService?: IEntitiesService;
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
  private log: Logger;

  constructor(private readonly deps: HttpServerDeps) {
    this.app = express();
    this.app.use(express.json());
    this.app.use(this.cors.bind(this));
    this.registerRoutes();
    this.app.use(this.errorHandler.bind(this));
    this.log = deps.log;
  }

  // ── CORS ──────────────────────────────────────────────────────────────────

  private cors(req: Request, res: Response, next: NextFunction): void {
    const allowedOrigins = this.deps.config.corsOrigins;
    const requestOrigin = req.headers.origin ?? "";
    const origin = allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : (allowedOrigins[0] ?? "http://localhost:4200");

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS",
    );
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  }

  // ── Route registration ────────────────────────────────────────────────────

  private registerRoutes(): void {
    this.registerAuthRoutes();
    this.registerScrapingRoutes();
    this.registerIntegrationsRoutes();
    this.registerEntitiesRoutes();
  }

  // ── Auth routes ───────────────────────────────────────────────────────────

  private registerAuthRoutes(): void {
    /**
     * GET /auth/airtable/start
     * Generates a PKCE code verifier + state, stores them, and redirects the
     * user to Airtable's OAuth consent page.
     */
    this.app.get("/auth/airtable/start", (_req: Request, res: Response) => {
      // Purge stale pending entries on each new attempt.
      this.purgeStalePendingAuth();

      const { url, codeVerifier, state } =
        this.deps.oauthService.buildAuthorizationUrl();
      this.log.info("authorization response", {
        url,
        codeVerifier,
        state,
      });

      this.pendingAuth.set(state, {
        codeVerifier,
        state,
        expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
      });

      this.deps.log.info("OAuth flow started", { state });
      res.redirect(url);
    });

    /**
     * GET /auth/airtable/callback
     * Receives the authorization code from Airtable, exchanges it for tokens,
     * persists them, then redirects the user back to the frontend.
     */
    this.app.get(
      "/auth/airtable/callback",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const {
            code,
            state: receivedState,
            error,
            error_description,
          } = req.query as Record<string, string | undefined>;
          console.log({
            code,
            receivedState,
            error,
            errorDesc: error_description,
          });

          if (error) {
            this.deps.log.warn("OAuth callback error from Airtable", {
              error,
              error_description,
            });
            const frontendOrigin =
              this.deps.config.corsOrigins[0] ?? "http://localhost:4200";
            res.redirect(
              `${frontendOrigin}/integrations?error=${encodeURIComponent(error ?? "unknown")}`,
            );
            return;
          }

          if (!code || !receivedState) {
            res.status(400).json({ error: "Missing code or state parameter" });
            return;
          }

          const pending = this.pendingAuth.get(receivedState);
          if (!pending || pending.expiresAt < Date.now()) {
            res.status(400).json({ error: "Invalid or expired OAuth state" });
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
          this.deps.log.info("OAuth tokens stored", { scope: tokenSet.scope });

          const frontendOrigin =
            this.deps.config.corsOrigins[0] ?? "http://localhost:4200";
          res.redirect(`${frontendOrigin}/integrations?connected=true`);
        } catch (err) {
          next(err);
        }
      },
    );

    /**
     * GET /auth/status
     * Returns whether a valid OAuth token is currently stored.
     */
    this.app.get(
      "/auth/status",
      async (_req: Request, res: Response, next: NextFunction) => {
        try {
          const connected = await this.deps.tokenProvider.isConnected();
          res.json({ connected });
        } catch (err) {
          next(err);
        }
      },
    );

    /**
     * DELETE /auth/airtable/disconnect
     * Removes the stored tokens, requiring re-authentication.
     */
    this.app.delete(
      "/auth/airtable/disconnect",
      async (_req: Request, res: Response, next: NextFunction) => {
        try {
          await this.deps.tokenRepository.delete();
          this.deps.log.info("OAuth tokens removed");
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
    const runSvc = this.deps.scrapeRunService;

    /**
     * POST /scraping/run
     * Starts (or continues after MFA) a manual scraping run.
     * Returns { runId, status } or 409 if a run is already active.
     */
    this.app.post("/scraping/run", (_req: Request, res: Response) => {
      if (!runSvc) {
        res.status(503).json({
          error: "SCRAPING_UNAVAILABLE",
          message: "Scraping service not configured",
        });
        return;
      }
      const result = runSvc.start();
      if ("conflict" in result) {
        res.status(409).json({
          error: "RUN_IN_PROGRESS",
          message: "A scraping run is already active.",
        });
        return;
      }
      res.json(result);
    });

    /**
     * GET /scraping/run
     * Returns the current run snapshot { runId, status, error, startedAt, finishedAt }.
     */
    this.app.get("/scraping/run", (_req: Request, res: Response) => {
      if (!runSvc) {
        res.json({
          runId: null,
          status: "idle",
          error: null,
          startedAt: null,
          finishedAt: null,
        });
        return;
      }
      const run = runSvc.getCurrentRun();
      if (!run) {
        res.json({
          runId: null,
          status: "idle",
          error: null,
          startedAt: null,
          finishedAt: null,
        });
        return;
      }
      res.json(run);
    });

    /**
     * GET /scraping/run/stream
     * SSE stream — emits buffered + live log events, then a terminal status event.
     */
    this.app.get("/scraping/run/stream", (req: Request, res: Response) => {
      if (!runSvc) {
        res.status(503).json({
          error: "SCRAPING_UNAVAILABLE",
          message: "Scraping service not configured",
        });
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      // Do NOT set Access-Control-Allow-Origin here — the cors() middleware
      // already set it correctly for the request origin (including ngrok URLs).
      res.flushHeaders();

      runSvc.addSseClient(res);
      req.on("close", () => runSvc.removeSseClient(res));
    });

    /**
     * POST /scraping/mfa
     * Body: { sessionId: string, code: string }
     * Feeds a TOTP code into the paused Puppeteer login flow.
     * After success the frontend re-POSTs /scraping/run to continue.
     */
    this.app.post(
      "/scraping/mfa",
      async (req: Request, res: Response, next: NextFunction) => {
        if (!orchestrator) {
          res.status(503).json({
            error: "SCRAPING_UNAVAILABLE",
            message: "Scraping service not configured",
          });
          return;
        }
        try {
          const { sessionId, code } = req.body as {
            sessionId?: string;
            code?: string;
          };
          if (!sessionId || !code) {
            res.status(400).json({
              error: "BAD_REQUEST",
              message: "sessionId and code are required",
            });
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

  // ── Integrations routes ───────────────────────────────────────────────────

  private registerIntegrationsRoutes(): void {
    /**
     * GET /integrations
     * Returns the list of supported integrations and their connection state.
     */
    this.app.get(
      "/integrations",
      async (_req: Request, res: Response, next: NextFunction) => {
        try {
          const connected = await this.deps.tokenProvider.isConnected();
          res.json([{ id: "airtable", name: "Airtable", connected }]);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // ── Entities routes ───────────────────────────────────────────────────────

  private registerEntitiesRoutes(): void {
    const svc = this.deps.entitiesService;

    /**
     * GET /entities
     * Lists available entity collections with document counts.
     */
    this.app.get(
      "/entities",
      async (_req: Request, res: Response, next: NextFunction) => {
        if (!svc) {
          res.json(KNOWN_ENTITIES.map((name) => ({ name, count: 0 })));
          return;
        }
        try {
          const entities = await svc.listEntities();
          res.json(entities);
        } catch (err) {
          next(err);
        }
      },
    );

    /**
     * GET /entities/:name/data
     * Returns a paginated, filterable, sortable page of documents from the
     * named collection. Field names are inferred from the returned documents.
     *
     * Query params:
     *   page        integer ≥1 (default 1)
     *   pageSize    integer 1–200 (default 50)
     *   search      free-text match across all string fields
     *   sortField   field name
     *   sortDir     "asc" | "desc" (default "desc")
     *   filterField field name
     *   filterOp    "eq" | "contains" | "gt" | "lt" (default "eq")
     *   filterValue string value to compare against
     */
    this.app.get(
      "/entities/:name/data",
      async (req: Request, res: Response, next: NextFunction) => {
        if (!svc) {
          res.status(503).json({
            error: "ENTITIES_UNAVAILABLE",
            message: "Entity service not configured",
          });
          return;
        }

        const name = req.params["name"] as string;
        if (!KNOWN_ENTITIES.includes(name)) {
          res
            .status(404)
            .json({ error: "NOT_FOUND", message: `Unknown entity: ${name}` });
          return;
        }

        const q = req.query as Record<string, string | undefined>;

        const page = Math.max(1, parseInt(q["page"] ?? "1", 10) || 1);
        const pageSize = Math.min(
          200,
          Math.max(1, parseInt(q["pageSize"] ?? "50", 10) || 50),
        );

        const validFilterOps: FilterOp[] = ["eq", "contains", "gt", "lt"];
        const rawFilterOp = q["filterOp"];
        const filterOp: FilterOp | undefined =
          rawFilterOp && (validFilterOps as string[]).includes(rawFilterOp)
            ? (rawFilterOp as FilterOp)
            : undefined;

        try {
          const sortDir =
            q["sortDir"] === "asc" || q["sortDir"] === "desc"
              ? q["sortDir"]
              : undefined;
          const result = await svc.queryEntity(name, {
            page,
            pageSize,
            ...(q["search"] ? { search: q["search"] } : {}),
            ...(q["sortField"] ? { sortField: q["sortField"] } : {}),
            ...(sortDir ? { sortDir } : {}),
            ...(q["filterField"] ? { filterField: q["filterField"] } : {}),
            ...(filterOp ? { filterOp } : {}),
            ...(q["filterValue"] ? { filterValue: q["filterValue"] } : {}),
          });
          res.json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // ── Error handler ─────────────────────────────────────────────────────────

  private errorHandler(
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): void {
    if (err instanceof AppError) {
      this.deps.log.warn("Application error", {
        code: err.code,
        message: err.message,
      });
      res
        .status(err.statusCode)
        .json({ error: err.code, message: err.message });
      return;
    }

    const message =
      err instanceof Error ? err.message : "Internal server error";
    this.deps.log.error("Unhandled error", {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    res.status(500).json({ error: "INTERNAL_ERROR", message });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.deps.config.port, () => {
        this.deps.log.info("HTTP server listening", {
          port: this.deps.config.port,
        });
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
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

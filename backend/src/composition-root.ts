import { loadConfig, type AppConfig } from './config/index.js';
import { logger, type Logger } from './core/logger/index.js';

/**
 * Composition root — the single place where the object graph is wired by hand.
 *
 * There is no DI container: every service is a plain class that declares its
 * collaborators as constructor parameters, and they are constructed here in
 * dependency order with explicit `new`. This is what enforces the "D" in SOLID
 * (callers depend on interfaces; concrete classes are chosen only here).
 *
 * As later phases add services, instantiate them in this function and expose
 * the ones that `main.ts` needs (HTTP server, cron scheduler, queue manager)
 * on the returned `Application`.
 */
export interface Application {
  config: AppConfig;
  logger: Logger;
  shutdown: () => Promise<void>;
}

export function buildApplication(): Application {
  // ── Config & Logger (no dependencies) ───────────────────────────────────────
  const config = loadConfig();
  const log = logger.child('app');

  // ── Infrastructure (Phase 1) ────────────────────────────────────────────────
  // const httpClient = new FetchHttpClient(log.child('http'));
  // const rateLimiter = new TokenBucketRateLimiter(config.airtable.rps);
  // const mongo = new MongoConnection(config.mongo.uri, log.child('mongo'));
  // const queueManager = new BullMqQueueManager(config.redis, log.child('queue'));
  // const browserManager = new PuppeteerBrowserManager(log.child('browser'));

  // ── Repositories (Phase 2) ───────────────────────────────────────────────────
  // const baseRepository = new MongoBaseRepository();
  // const tableRepository = new MongoTableRepository();
  // ...

  // ── Auth (Phase 3) ────────────────────────────────────────────────────────────
  // const oauthService = new OAuthService(config, httpClient);
  // const tokenProvider = new TokenProvider(oauthService, tokenRepository);

  // ── Airtable API (Phase 4) ──────────────────────────────────────────────────
  // const apiService = new AirtableApiService(config, httpClient, tokenProvider, rateLimiter);

  // ── Scraping (Phases 6–7) ───────────────────────────────────────────────────
  // const sessionOrchestrator = new SessionOrchestrator(config, browserManager, scrapeSessionRepository);
  // const revisionParser = new RevisionHistoryParser();
  // const revisionService = new RevisionHistoryService(sessionOrchestrator, revisionParser, ...);

  // ── Pipeline & Cron (Phase 5) ───────────────────────────────────────────────
  // const pipelineProducer = new PipelineProducer(queueManager);
  // const cronScheduler = new CronScheduler(config, queueManager, baseRepository, apiService, pipelineProducer);

  const shutdown = async (): Promise<void> => {
    log.info('Shutting down');
    // await queueManager.closeAll();
    // await browserManager.close();
    // await mongo.disconnect();
  };

  return { config, logger: log, shutdown };
}

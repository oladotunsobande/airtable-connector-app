import { loadConfig, type AppConfig } from './config/index.js';
import { logger, type Logger } from './core/logger/index.js';

import { MongoConnection } from './infrastructure/mongo/mongo-connection.js';
import { FetchHttpClient } from './infrastructure/http/fetch-http-client.js';
import { TokenBucketRateLimiter } from './infrastructure/rate-limit/token-bucket-rate-limiter.js';
import { BullMqQueueManager } from './infrastructure/queue/bullmq-queue-manager.js';

import type { IHttpClient } from './infrastructure/http/http-client.interface.js';
import type { IRateLimiter } from './infrastructure/rate-limit/rate-limiter.interface.js';

/**
 * The wired application surface exposed to main.ts.
 * Only the things `main.ts` needs to start/stop the process appear here.
 * Everything else lives inside the closure of buildApplication().
 */
export interface Application {
  config: AppConfig;
  logger: Logger;
  // Infrastructure — exposed so main.ts can start servers / workers
  mongo: MongoConnection;
  queueManager: BullMqQueueManager;
  // Shared singletons used by later phases (exposed for convenience)
  httpClient: IHttpClient;
  rateLimiter: IRateLimiter;
  shutdown: () => Promise<void>;
}

/**
 * Composition root — single manual-wiring point.
 *
 * Dependency order: leaf services first, consumers after.
 * Each phase's services are wired here; later phases uncomment their blocks.
 */
export function buildApplication(): Application {
  // ── Phase 0: Config & Logger ─────────────────────────────────────────────────
  const config = loadConfig();
  const log = logger.child('app');

  // ── Phase 1: Core infrastructure ─────────────────────────────────────────────
  const mongo = new MongoConnection(config.mongo.uri, log.child('mongo'));

  const httpClient = new FetchHttpClient(log.child('http'));

  const rateLimiter = new TokenBucketRateLimiter(config.airtable.rps);

  const queueManager = new BullMqQueueManager(config.redis, log.child('queue'));

  // ── Phase 2: Repositories ────────────────────────────────────────────────────
  // (uncomment after Phase 2 is implemented)
  // const baseRepository = new MongoBaseRepository();
  // const tableRepository = new MongoTableRepository();
  // const pageRepository = new MongoPageRepository();
  // const revisionHistoryRepository = new MongoRevisionHistoryRepository();
  // const userRepository = new MongoUserRepository();
  // const scrapeSessionRepository = new MongoScrapeSessionRepository();

  // ── Phase 3: OAuth ───────────────────────────────────────────────────────────
  // const tokenRepository = new MongoTokenRepository();
  // const oauthService = new OAuthService(config, httpClient);
  // const tokenProvider = new TokenProvider(oauthService, tokenRepository, log.child('token-provider'));

  // ── Phase 4: Airtable API ────────────────────────────────────────────────────
  // const apiService = new AirtableApiService(config, httpClient, tokenProvider, rateLimiter, log.child('airtable-api'));

  // ── Phase 5: Pipeline & Cron ─────────────────────────────────────────────────
  // const pipelineProducer = new PipelineProducer(queueManager, log.child('pipeline'));
  // const cronScheduler = new CronScheduler(config, queueManager, baseRepository, apiService, pipelineProducer, log.child('cron'));

  // ── Phase 6: Browser & Session ───────────────────────────────────────────────
  // const browserManager = new PuppeteerBrowserManager(log.child('browser'));
  // const sessionOrchestrator = new SessionOrchestrator(config, browserManager, scrapeSessionRepository, log.child('session'));

  // ── Phase 7: Revision History ────────────────────────────────────────────────
  // const revisionParser = new RevisionHistoryParser();
  // const revisionService = new RevisionHistoryService(sessionOrchestrator, revisionParser, revisionHistoryRepository, userRepository, rateLimiter, log.child('revision'));

  // ── Phase 8: HTTP Server ─────────────────────────────────────────────────────
  // const httpServer = new HttpServer(config, oauthService, tokenProvider, apiService, queueManager, sessionOrchestrator, log.child('http-server'));

  const shutdown = async (): Promise<void> => {
    log.info('Shutting down gracefully');
    // await httpServer.stop();
    // await cronScheduler.shutdown();
    await queueManager.closeAll();
    // await browserManager.close();
    await mongo.disconnect();
  };

  return {
    config,
    logger: log,
    mongo,
    queueManager,
    httpClient,
    rateLimiter,
    shutdown,
  };
}

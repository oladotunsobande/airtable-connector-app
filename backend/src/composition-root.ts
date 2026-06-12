import { loadConfig, type AppConfig } from './config/index.js';
import { logger, type Logger } from './core/logger/index.js';

import { MongoConnection } from './infrastructure/mongo/mongo-connection.js';
import { FetchHttpClient } from './infrastructure/http/fetch-http-client.js';
import { TokenBucketRateLimiter } from './infrastructure/rate-limit/token-bucket-rate-limiter.js';
import { BullMqQueueManager } from './infrastructure/queue/bullmq-queue-manager.js';

import { MongoBaseRepository } from './modules/airtable/models/mongo-base.repository.js';
import { MongoTableRepository } from './modules/airtable/models/mongo-table.repository.js';
import { MongoPageRepository } from './modules/airtable/models/mongo-page.repository.js';
import { MongoRevisionHistoryRepository } from './modules/airtable/models/mongo-revision-history.repository.js';
import { MongoUserRepository } from './modules/airtable/models/mongo-user.repository.js';
import { MongoScrapeSessionRepository } from './modules/airtable/models/mongo-scrape-session.repository.js';
import { MongoTokenRepository } from './modules/airtable/auth/mongo-token.repository.js';
import { OAuthService } from './modules/airtable/auth/oauth.service.js';
import { TokenProvider } from './modules/airtable/auth/token-provider.js';
import { AirtableApiService } from './modules/airtable/api/airtable-api.service.js';
import { IngestService } from './modules/airtable/api/ingest.service.js';
import { HttpServer } from './api/http-server.js';

import type { IHttpClient } from './infrastructure/http/http-client.interface.js';
import type { IRateLimiter } from './infrastructure/rate-limit/rate-limiter.interface.js';
import type { IBaseRepository } from './modules/airtable/models/base.repository.interface.js';
import type { ITableRepository } from './modules/airtable/models/table.repository.interface.js';
import type { IPageRepository } from './modules/airtable/models/page.repository.interface.js';
import type { IRevisionHistoryRepository } from './modules/airtable/models/revision-history.repository.interface.js';
import type { IUserRepository } from './modules/airtable/models/user.repository.interface.js';
import type { IScrapeSessionRepository } from './modules/airtable/models/scrape-session.repository.interface.js';
import type { ITokenRepository } from './modules/airtable/auth/token.repository.interface.js';
import type { IOAuthService } from './modules/airtable/auth/oauth.service.interface.js';
import type { ITokenProvider } from './modules/airtable/auth/token-provider.interface.js';
import type { IAirtableApiService } from './modules/airtable/api/airtable-api.service.interface.js';
import type { IIngestService } from './modules/airtable/api/ingest.service.js';

export interface Application {
  config: AppConfig;
  logger: Logger;
  // Infrastructure
  mongo: MongoConnection;
  queueManager: BullMqQueueManager;
  httpServer: HttpServer;
  // Shared singletons
  httpClient: IHttpClient;
  rateLimiter: IRateLimiter;
  // Auth
  oauthService: IOAuthService;
  tokenProvider: ITokenProvider;
  tokenRepository: ITokenRepository;
  // Airtable API
  apiService: IAirtableApiService;
  ingestService: IIngestService;
  // Repositories
  baseRepository: IBaseRepository;
  tableRepository: ITableRepository;
  pageRepository: IPageRepository;
  revisionHistoryRepository: IRevisionHistoryRepository;
  userRepository: IUserRepository;
  scrapeSessionRepository: IScrapeSessionRepository;
  shutdown: () => Promise<void>;
}

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
  const baseRepository = new MongoBaseRepository();
  const tableRepository = new MongoTableRepository();
  const pageRepository = new MongoPageRepository();
  const revisionHistoryRepository = new MongoRevisionHistoryRepository();
  const userRepository = new MongoUserRepository();
  const scrapeSessionRepository = new MongoScrapeSessionRepository();
  const tokenRepository = new MongoTokenRepository(config.encryption.key);

  // ── Phase 3: OAuth ───────────────────────────────────────────────────────────
  const oauthService = new OAuthService(config, httpClient);
  const tokenProvider = new TokenProvider(oauthService, tokenRepository, log.child('token-provider'));

  // ── Phase 4: Airtable API ────────────────────────────────────────────────────
  const apiService = new AirtableApiService(
    config,
    httpClient,
    tokenProvider,
    rateLimiter,
    log.child('airtable-api'),
  );
  const ingestService = new IngestService(
    apiService,
    baseRepository,
    tableRepository,
    pageRepository,
    log.child('ingest'),
  );

  // ── Phase 5: Pipeline & Cron ─────────────────────────────────────────────────
  // const pipelineProducer = new PipelineProducer(queueManager, log.child('pipeline'));
  // const cronScheduler = new CronScheduler(config, queueManager, baseRepository, ingestService, pipelineProducer, log.child('cron'));

  // ── Phase 6: Browser & Session ───────────────────────────────────────────────
  // const browserManager = new PuppeteerBrowserManager(log.child('browser'));
  // const sessionOrchestrator = new SessionOrchestrator(config, browserManager, scrapeSessionRepository, log.child('session'));

  // ── Phase 7: Revision History ────────────────────────────────────────────────
  // const revisionParser = new RevisionHistoryParser();
  // const revisionService = new RevisionHistoryService(sessionOrchestrator, revisionParser, revisionHistoryRepository, userRepository, rateLimiter, log.child('revision'));

  // ── HTTP Server (grows with each phase) ──────────────────────────────────────
  const httpServer = new HttpServer({
    config,
    oauthService,
    tokenProvider,
    tokenRepository,
    log: log.child('http-server'),
  });

  const shutdown = async (): Promise<void> => {
    log.info('Shutting down gracefully');
    await httpServer.stop();
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
    httpServer,
    httpClient,
    rateLimiter,
    oauthService,
    tokenProvider,
    tokenRepository,
    apiService,
    ingestService,
    baseRepository,
    tableRepository,
    pageRepository,
    revisionHistoryRepository,
    userRepository,
    scrapeSessionRepository,
    shutdown,
  };
}

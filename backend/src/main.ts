import 'dotenv/config';
import { buildApplication } from './composition-root.js';

async function bootstrap(): Promise<void> {
  const app = buildApplication();
  const { config, logger: log } = app;

  log.info('Starting Airtable Connector backend', { env: config.nodeEnv, port: config.port });

  // Connect to MongoDB (schemas are registered on import, connection is shared).
  await app.mongo.connect();

  // Start the HTTP server (auth routes live, more routes added in later phases).
  await app.httpServer.start();

  // TODO (Phase 5): start BullMQ workers + cron scheduler
  // TODO (Phase 6+): register remaining routes on httpServer before starting

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info('Received shutdown signal', { signal });
    await app.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log.info('Backend ready', { port: config.port });
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal startup error: ${message}\n`);
  process.exit(1);
});

import 'dotenv/config';
import { buildApplication } from './composition-root.js';

async function bootstrap(): Promise<void> {
  const app = buildApplication();
  const { config, logger: log } = app;

  log.info('Starting Airtable Connector backend', { env: config.nodeEnv, port: config.port });

  // TODO (Phase 1+): start HTTP server, register cron jobs, start workers
  // (these are constructed in composition-root and started here).

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info('Received shutdown signal', { signal });
    await app.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log.info('Bootstrap complete — waiting for infrastructure wiring');
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal startup error: ${message}\n`);
  process.exit(1);
});

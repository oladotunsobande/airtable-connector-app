import type { AppConfig } from '../../../config/index.js';
import type { Logger } from '../../../core/logger/index.js';
import type { BullMqQueueManager } from '../../../infrastructure/queue/bullmq-queue-manager.js';
import type { IBaseRepository } from '../models/base.repository.interface.js';
import type { ITableRepository } from '../models/table.repository.interface.js';
import type { IPageRepository } from '../models/page.repository.interface.js';
import type { IIngestService } from '../api/ingest.service.js';
import type { PipelineProducer } from '../pipeline/pipeline-producer.js';

import { createCronProcessor } from '../pipeline/workers/cron.processor.js';
import { createBasesProcessor } from '../pipeline/workers/bases.processor.js';
import { createTablesProcessor } from '../pipeline/workers/tables.processor.js';
import { createRevisionHistoryProcessor } from '../pipeline/workers/revision-history.processor.js';

const CRON_EVERY_MS = 5 * 60 * 1_000; // 5 minutes

export class CronScheduler {
  constructor(
    private readonly config: AppConfig,
    private readonly queueManager: BullMqQueueManager,
    private readonly baseRepository: IBaseRepository,
    private readonly tableRepository: ITableRepository,
    private readonly pageRepository: IPageRepository,
    private readonly ingestService: IIngestService,
    private readonly producer: PipelineProducer,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.registerWorkers();
    await this.scheduleRepeatingJob();
    this.log.info('CronScheduler started', { everyMs: CRON_EVERY_MS });
  }

  private registerWorkers(): void {
    // Concurrency 1: the cron tick is a coordinator, not a compute job.
    this.queueManager.registerWorker(
      'cron',
      createCronProcessor({
        config: this.config,
        baseRepository: this.baseRepository,
        ingestService: this.ingestService,
        producer: this.producer,
        log: this.log.child('cron-processor'),
      }),
      1,
    );

    // Concurrency 3: parallelise base processing without hammering the API.
    this.queueManager.registerWorker(
      'bases',
      createBasesProcessor({
        baseRepository: this.baseRepository,
        tableRepository: this.tableRepository,
        ingestService: this.ingestService,
        producer: this.producer,
        log: this.log.child('bases-processor'),
      }),
      3,
    );

    // Concurrency 3: each table worker runs getRecords independently.
    this.queueManager.registerWorker(
      'tables',
      createTablesProcessor({
        tableRepository: this.tableRepository,
        pageRepository: this.pageRepository,
        ingestService: this.ingestService,
        producer: this.producer,
        log: this.log.child('tables-processor'),
      }),
      3,
    );

    // Concurrency 5: revision-history scraping (Phase 7) will be I/O-heavy.
    this.queueManager.registerWorker(
      'revision-history',
      createRevisionHistoryProcessor({
        pageRepository: this.pageRepository,
        log: this.log.child('revision-history-processor'),
      }),
      5,
    );
  }

  /**
   * Adds the pipeline-tick repeatable job to the `cron` queue.
   * `upsertJobScheduler` is idempotent — safe to call on every restart.
   */
  private async scheduleRepeatingJob(): Promise<void> {
    const queue = this.queueManager.getQueue('cron');
    await queue.upsertJobScheduler(
      'pipeline-tick',
      { every: CRON_EVERY_MS },
      { name: 'pipeline-tick', data: { scheduledAt: new Date().toISOString() } },
    );
    this.log.info('Repeatable cron job upserted', { schedulerId: 'pipeline-tick' });
  }
}

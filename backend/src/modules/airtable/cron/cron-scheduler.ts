import type { AppConfig } from "../../../config/index.js";
import type { Logger } from "../../../core/logger/index.js";
import type { BullMqQueueManager } from "../../../infrastructure/queue/bullmq-queue-manager.js";
import type { IBaseRepository } from "../models/base.repository.interface.js";
import type { ITableRepository } from "../models/table.repository.interface.js";
import type { IPageRepository } from "../models/page.repository.interface.js";
import type { IIngestService } from "../api/ingest.service.js";
import type { IRevisionHistoryService } from "../scraping/revision-history.service.interface.js";
import type { PipelineProducer } from "../pipeline/pipeline-producer.js";

import { createCronProcessor } from "../pipeline/workers/cron.processor.js";
import { createBasesProcessor } from "../pipeline/workers/bases.processor.js";
import { createTablesProcessor } from "../pipeline/workers/tables.processor.js";
import { createRevisionHistoryProcessor } from "../pipeline/workers/revision-history.processor.js";

export class PipelineWorkers {
  constructor(
    private readonly config: AppConfig,
    private readonly queueManager: BullMqQueueManager,
    private readonly baseRepository: IBaseRepository,
    private readonly tableRepository: ITableRepository,
    private readonly pageRepository: IPageRepository,
    private readonly ingestService: IIngestService,
    private readonly revisionHistoryService: IRevisionHistoryService,
    private readonly producer: PipelineProducer,
    private readonly log: Logger,
  ) {}

  registerWorkers(): void {
    this.queueManager.registerWorker(
      "cron",
      createCronProcessor({
        config: this.config,
        baseRepository: this.baseRepository,
        ingestService: this.ingestService,
        producer: this.producer,
        log: this.log.child("cron-processor"),
      }),
      1,
    );

    this.queueManager.registerWorker(
      "bases",
      createBasesProcessor({
        baseRepository: this.baseRepository,
        tableRepository: this.tableRepository,
        ingestService: this.ingestService,
        producer: this.producer,
        log: this.log.child("bases-processor"),
      }),
      3,
    );

    this.queueManager.registerWorker(
      "tables",
      createTablesProcessor({
        tableRepository: this.tableRepository,
        pageRepository: this.pageRepository,
        ingestService: this.ingestService,
        producer: this.producer,
        log: this.log.child("tables-processor"),
      }),
      3,
    );

    this.queueManager.registerWorker(
      "revision-history",
      createRevisionHistoryProcessor({
        revisionHistoryService: this.revisionHistoryService,
        pageRepository: this.pageRepository,
        log: this.log.child("revision-history-processor"),
      }),
      5,
    );

    this.log.info("Pipeline workers registered");
  }
}

import type { Processor } from "bullmq";
import type { AppConfig } from "../../../../config/index.js";
import type { Logger } from "../../../../core/logger/index.js";
import type { IBaseRepository } from "../../models/base.repository.interface.js";
import type { IIngestService } from "../../api/ingest.service.js";
import type { PipelineProducer } from "../pipeline-producer.js";
import type { CronJobPayload } from "../job-payloads.js";

export interface CronProcessorDeps {
  config: AppConfig;
  baseRepository: IBaseRepository;
  ingestService: IIngestService;
  producer: PipelineProducer;
  log: Logger;
}

export function createCronProcessor(
  deps: CronProcessorDeps,
): Processor<CronJobPayload> {
  return async (_job) => {
    const { config, baseRepository, ingestService, producer, log } = deps;

    log.info("Pipeline cron tick started");

    // Bootstrap: fetch bases from Airtable if the collection is empty.
    const baseCount = await baseRepository.count();
    if (baseCount === 0) {
      log.info("No bases in DB — fetching from Airtable API");
      await ingestService.ingestBases();
    }

    // Pick bases that are not currently processing, oldest-first (nulls first).
    const bases = await baseRepository.findForProcessing(5);
    if (bases.length === 0) {
      log.info("No bases eligible for processing this tick");
      return;
    }

    for (const base of bases) {
      await baseRepository.updateStatus(base.airtableId, "queued");
      await producer.enqueueBase({
        baseId: base.airtableId,
        baseName: base.name,
      });
    }

    log.info("Bases enqueued for processing", { count: bases.length });
  };
}

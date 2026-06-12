import type { Processor } from 'bullmq';
import type { Logger } from '../../../../core/logger/index.js';
import type { IBaseRepository } from '../../models/base.repository.interface.js';
import type { ITableRepository } from '../../models/table.repository.interface.js';
import type { IIngestService } from '../../api/ingest.service.js';
import type { PipelineProducer } from '../pipeline-producer.js';
import type { BasesJobPayload } from '../job-payloads.js';

export interface BasesProcessorDeps {
  baseRepository: IBaseRepository;
  tableRepository: ITableRepository;
  ingestService: IIngestService;
  producer: PipelineProducer;
  log: Logger;
}

export function createBasesProcessor(deps: BasesProcessorDeps): Processor<BasesJobPayload> {
  return async (job) => {
    const { baseId, baseName } = job.data;
    const { baseRepository, tableRepository, ingestService, producer, log } = deps;

    log.info('Processing base', { baseId, baseName });
    await baseRepository.updateStatus(baseId, 'processing');

    try {
      await ingestService.ingestTables(baseId);

      const tables = await tableRepository.findByBaseId(baseId);
      await Promise.all(
        tables.map((t) =>
          producer.enqueueTables({ baseId, tableId: t.airtableId, tableName: t.name }),
        ),
      );

      await baseRepository.markSuccessful(baseId);
      log.info('Base processed', { baseId, baseName, tableCount: tables.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await baseRepository.updateStatus(baseId, 'error', { message, occurredAt: new Date() });
      throw err;
    }
  };
}

import type { Processor } from 'bullmq';
import type { Logger } from '../../../../core/logger/index.js';
import type { ITableRepository } from '../../models/table.repository.interface.js';
import type { IPageRepository } from '../../models/page.repository.interface.js';
import type { IIngestService } from '../../api/ingest.service.js';
import type { PipelineProducer } from '../pipeline-producer.js';
import type { TablesJobPayload } from '../job-payloads.js';

const MAX_REVISION_JOBS_PER_TABLE = 5_000;

export interface TablesProcessorDeps {
  tableRepository: ITableRepository;
  pageRepository: IPageRepository;
  ingestService: IIngestService;
  producer: PipelineProducer;
  log: Logger;
}

export function createTablesProcessor(deps: TablesProcessorDeps): Processor<TablesJobPayload> {
  return async (job) => {
    const { baseId, tableId, tableName } = job.data;
    const { tableRepository, pageRepository, ingestService, producer, log } = deps;

    log.info('Processing table', { baseId, tableId, tableName });

    await ingestService.ingestRecords(baseId, tableId);

    // Enqueue revision-history scraping for all newly-upserted pending pages.
    const pendingPages = await pageRepository.findPendingRevisionByTable(
      baseId,
      tableId,
      MAX_REVISION_JOBS_PER_TABLE,
    );

    if (pendingPages.length > 0) {
      await Promise.all(
        pendingPages.map((p) =>
          producer.enqueueRevisionHistory({ baseId, tableId, pageId: p.airtableId }),
        ),
      );
    }

    await tableRepository.markProcessed(tableId);
    log.info('Table processed', { tableName, pendingRevisionCount: pendingPages.length });
  };
}

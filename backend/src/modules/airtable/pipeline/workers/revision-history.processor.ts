import type { Processor } from 'bullmq';
import type { Logger } from '../../../../core/logger/index.js';
import type { IPageRepository } from '../../models/page.repository.interface.js';
import type { IRevisionHistoryService } from '../../scraping/revision-history.service.interface.js';
import type { RevisionHistoryJobPayload } from '../job-payloads.js';

export interface RevisionHistoryProcessorDeps {
  revisionHistoryService: IRevisionHistoryService;
  pageRepository: IPageRepository;
  log: Logger;
}

export function createRevisionHistoryProcessor(
  deps: RevisionHistoryProcessorDeps,
): Processor<RevisionHistoryJobPayload> {
  return async (job) => {
    const { pageId, baseId, tableId } = job.data;
    const { revisionHistoryService, pageRepository, log } = deps;

    log.debug('Scraping revision history', { pageId, baseId, tableId });

    try {
      await revisionHistoryService.scrapeForPage(baseId, tableId, pageId);
      await pageRepository.updateRevisionStatus(pageId, 'scraped', new Date());
      log.info('Revision history scraped', { pageId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Revision history scrape failed', { pageId, error: message });
      await pageRepository.updateRevisionStatus(pageId, 'error').catch(() => {});
      throw err; // rethrow so BullMQ applies retry backoff
    }
  };
}

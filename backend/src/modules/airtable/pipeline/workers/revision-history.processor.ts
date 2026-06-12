import type { Processor } from 'bullmq';
import type { Logger } from '../../../../core/logger/index.js';
import type { IPageRepository } from '../../models/page.repository.interface.js';
import type { RevisionHistoryJobPayload } from '../job-payloads.js';

export interface RevisionHistoryProcessorDeps {
  pageRepository: IPageRepository;
  log: Logger;
}

/**
 * Phase 7 will replace this stub with the actual Puppeteer-based scraping logic.
 * For now the job is acknowledged so the queue doesn't back up, and the page
 * stays in `pending` status until Phase 7 marks it `scraped`.
 */
export function createRevisionHistoryProcessor(
  deps: RevisionHistoryProcessorDeps,
): Processor<RevisionHistoryJobPayload> {
  return async (job) => {
    const { pageId, baseId, tableId } = job.data;
    deps.log.debug('Revision history job received — Phase 7 pending', { pageId, baseId, tableId });
  };
}

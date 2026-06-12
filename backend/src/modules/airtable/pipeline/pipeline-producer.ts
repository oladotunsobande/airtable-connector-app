import type { BullMqQueueManager } from '../../../infrastructure/queue/bullmq-queue-manager.js';
import type { BasesJobPayload, TablesJobPayload, RevisionHistoryJobPayload } from './job-payloads.js';

export class PipelineProducer {
  constructor(private readonly queueManager: BullMqQueueManager) {}

  async enqueueBase(payload: BasesJobPayload): Promise<void> {
    await this.queueManager.getQueue('bases').add('process-base', payload, {
      jobId: `base:${payload.baseId}`,
    });
  }

  async enqueueTables(payload: TablesJobPayload): Promise<void> {
    await this.queueManager.getQueue('tables').add('process-table', payload, {
      jobId: `table:${payload.tableId}`,
    });
  }

  async enqueueRevisionHistory(payload: RevisionHistoryJobPayload): Promise<void> {
    await this.queueManager.getQueue('revision-history').add('scrape-revision', payload, {
      jobId: `revision:${payload.pageId}`,
    });
  }
}

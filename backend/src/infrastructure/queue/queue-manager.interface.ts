import type { Queue, Worker } from 'bullmq';

export type QueueName = 'cron' | 'bases' | 'tables' | 'revision-history';

export interface IQueueManager {
  getQueue(name: QueueName): Queue;
  getWorker(name: QueueName): Worker | undefined;
  closeAll(): Promise<void>;
}

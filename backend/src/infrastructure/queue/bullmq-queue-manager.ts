import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';
import type { Logger } from '../../core/logger/index.js';
import type { IQueueManager, QueueName } from './queue-manager.interface.js';

export interface WorkerRegistration {
  name: QueueName;
  processor: Processor;
  concurrency?: number;
}

export class BullMqQueueManager implements IQueueManager {
  private readonly connection: ConnectionOptions;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Map<QueueName, Worker>();

  constructor(
    redisConfig: { host: string; port: number },
    private readonly log: Logger,
  ) {
    this.connection = { host: redisConfig.host, port: redisConfig.port };
  }

  getQueue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        },
      });
      this.queues.set(name, queue);
      this.log.info('Queue created', { name });
    }
    return queue;
  }

  /**
   * Registers a processor for a queue and starts a worker.
   * Workers are created lazily on first `registerWorker` call.
   */
  registerWorker(name: QueueName, processor: Processor, concurrency = 5): Worker {
    if (this.workers.has(name)) {
      throw new Error(`Worker for queue '${name}' is already registered`);
    }

    const worker = new Worker(name, processor, {
      connection: this.connection,
      concurrency,
    });

    worker.on('completed', (job) =>
      this.log.info('Job completed', { queue: name, jobId: job.id }),
    );
    worker.on('failed', (job, err) =>
      this.log.error('Job failed', {
        queue: name,
        jobId: job?.id,
        error: err.message,
        stack: err.stack,
      }),
    );
    worker.on('error', (err) =>
      this.log.error('Worker error', { queue: name, error: err.message }),
    );

    this.workers.set(name, worker);
    this.log.info('Worker registered', { queue: name, concurrency });
    return worker;
  }

  getWorker(name: QueueName): Worker | undefined {
    return this.workers.get(name);
  }

  async closeAll(): Promise<void> {
    this.log.info('Closing all queues and workers');
    await Promise.all([
      ...Array.from(this.workers.values()).map((w) => w.close()),
      ...Array.from(this.queues.values()).map((q) => q.close()),
    ]);
    this.log.info('All queues and workers closed');
  }
}

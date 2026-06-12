import type { IRateLimiter } from './rate-limiter.interface.js';

interface Bucket {
  tokens: number;
  lastRefillAt: number;
  queue: Array<() => void>;
  drainTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Per-key token-bucket rate limiter.
 *
 * Each unique key (e.g. a base ID) gets its own bucket.
 * `acquire(key)` returns a Promise that resolves only when a token is available,
 * so callers are transparently back-pressured without polling.
 *
 * Design:
 * - Capacity = rps (burst = 1 second's worth).
 * - Refill: one token every (1000 / rps) ms, up to capacity.
 * - Drain loop: runs at the refill interval while there are waiters; clears itself when the queue empties.
 */
export class TokenBucketRateLimiter implements IRateLimiter {
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(rps: number) {
    if (rps <= 0) throw new RangeError(`rps must be > 0, got ${rps}`);
    this.capacity = rps;
    this.refillIntervalMs = 1000 / rps;
  }

  acquire(key: string): Promise<void> {
    const bucket = this.getOrCreateBucket(key);

    this.refill(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return Promise.resolve();
    }

    // No token available — queue the waiter and start the drain loop if needed.
    return new Promise<void>((resolve) => {
      bucket.queue.push(resolve);
      this.ensureDrainLoop(key, bucket);
    });
  }

  private getOrCreateBucket(key: string): Bucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillAt: Date.now(), queue: [], drainTimer: null };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private refill(bucket: Bucket): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefillAt;
    const newTokens = (elapsed / this.refillIntervalMs);
    if (newTokens >= 1) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + Math.floor(newTokens));
      bucket.lastRefillAt = now;
    }
  }

  private ensureDrainLoop(key: string, bucket: Bucket): void {
    if (bucket.drainTimer !== null) return;

    bucket.drainTimer = setInterval(() => {
      this.refill(bucket);

      while (bucket.tokens >= 1 && bucket.queue.length > 0) {
        bucket.tokens -= 1;
        const resolve = bucket.queue.shift();
        resolve?.();
      }

      if (bucket.queue.length === 0) {
        clearInterval(bucket.drainTimer!);
        bucket.drainTimer = null;
      }
    }, this.refillIntervalMs);

    // Don't let this timer keep the Node process alive when everything else is done.
    if (typeof bucket.drainTimer === 'object' && 'unref' in bucket.drainTimer) {
      (bucket.drainTimer as NodeJS.Timeout).unref();
    }
  }
}

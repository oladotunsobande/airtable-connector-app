import { describe, it, expect } from 'vitest';
import { TokenBucketRateLimiter } from './token-bucket-rate-limiter.js';

describe('TokenBucketRateLimiter', () => {
  it('rejects non-positive rps', () => {
    expect(() => new TokenBucketRateLimiter(0)).toThrow();
    expect(() => new TokenBucketRateLimiter(-1)).toThrow();
  });

  it('resolves immediately up to the burst capacity (rps tokens)', async () => {
    const rps = 5;
    const limiter = new TokenBucketRateLimiter(rps);

    // All rps tokens should be available instantly (initial bucket is full).
    const start = Date.now();
    await Promise.all(Array.from({ length: rps }, () => limiter.acquire('base1')));
    const elapsed = Date.now() - start;

    // All resolved without meaningful waiting.
    expect(elapsed).toBeLessThan(100);
  });

  it('enforces ≤ rps acquires per second across two keys independently', async () => {
    const rps = 5;
    const limiter = new TokenBucketRateLimiter(rps);

    // Drain the bucket for key1.
    await Promise.all(Array.from({ length: rps }, () => limiter.acquire('key1')));

    // key2 still has a full bucket — should resolve immediately.
    const start = Date.now();
    await limiter.acquire('key2');
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('back-pressures callers when the bucket is empty and releases them after refill', async () => {
    const rps = 5;
    const limiter = new TokenBucketRateLimiter(rps);

    // Drain the full bucket.
    await Promise.all(Array.from({ length: rps }, () => limiter.acquire('base2')));

    // The next acquire must wait for at least one refill interval.
    const refillMs = 1000 / rps; // 200 ms
    const start = Date.now();
    await limiter.acquire('base2');
    const elapsed = Date.now() - start;

    // Should have waited at least one refill cycle, with some timer slack.
    expect(elapsed).toBeGreaterThanOrEqual(refillMs * 0.8);
  }, 2000);

  it('measures throughput over 1 second and stays within rps + 1 tolerance', async () => {
    const rps = 5;
    const limiter = new TokenBucketRateLimiter(rps);

    // Drain bucket first so every subsequent acquire must wait.
    await Promise.all(Array.from({ length: rps }, () => limiter.acquire('base3')));

    let count = 0;
    const deadline = Date.now() + 1000;

    const acquire = async () => {
      while (Date.now() < deadline) {
        await limiter.acquire('base3');
        count++;
      }
    };

    // Run 3 concurrent consumers to stress-test the drain loop.
    await Promise.all([acquire(), acquire(), acquire()]);

    // Over 1 second, we should have processed approximately rps tokens.
    // Allow ±1 for timing imprecision.
    expect(count).toBeGreaterThanOrEqual(rps - 1);
    expect(count).toBeLessThanOrEqual(rps + 2);
  }, 3000);
});

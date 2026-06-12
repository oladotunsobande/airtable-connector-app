export interface IRateLimiter {
  /** Resolves when a request token for the given key is available. */
  acquire(key: string): Promise<void>;
}

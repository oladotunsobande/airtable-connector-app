export interface ICronScheduler {
  /** Registers all recurring jobs. Called once at application startup. */
  registerAll(): Promise<void>;
  shutdown(): Promise<void>;
}

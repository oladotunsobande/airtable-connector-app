import mongoose from 'mongoose';
import type { Logger } from '../../core/logger/index.js';

export class MongoConnection {
  private connected = false;

  constructor(
    private readonly uri: string,
    private readonly log: Logger,
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;

    mongoose.connection.on('connected', () => this.log.info('MongoDB connected'));
    mongoose.connection.on('disconnected', () => this.log.warn('MongoDB disconnected'));
    mongoose.connection.on('error', (err: Error) =>
      this.log.error('MongoDB error', { error: err.message }),
    );

    await mongoose.connect(this.uri);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await mongoose.disconnect();
    this.connected = false;
    this.log.info('MongoDB disconnected gracefully');
  }
}

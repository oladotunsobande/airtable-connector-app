import { ScrapeSessionModel } from './schemas/scrape-session.schema.js';
import type {
  IScrapeSessionRepository,
  ScrapeSessionDocument,
  SessionState,
  SerializedCookie,
  HarvestedTokens,
} from './scrape-session.repository.interface.js';

export class MongoScrapeSessionRepository implements IScrapeSessionRepository {
  async save(session: ScrapeSessionDocument): Promise<ScrapeSessionDocument> {
    const doc = await ScrapeSessionModel.findOneAndUpdate(
      { sessionId: session.sessionId },
      { $set: session },
      { upsert: true, new: true },
    ).lean();

    if (!doc) throw new Error(`Save failed for session ${session.sessionId}`);
    return doc as ScrapeSessionDocument;
  }

  async findActive(): Promise<ScrapeSessionDocument | null> {
    const doc = await ScrapeSessionModel.findOne({
      state: { $in: ['active', 'awaiting_mfa'] },
    })
      .sort({ validatedAt: -1 })
      .lean();
    return doc as ScrapeSessionDocument | null;
  }

  async updateState(sessionId: string, state: SessionState, validatedAt?: Date): Promise<void> {
    const update: Record<string, unknown> = { state };
    if (validatedAt) update['validatedAt'] = validatedAt;
    await ScrapeSessionModel.updateOne({ sessionId }, { $set: update });
  }

  async updateTokens(
    sessionId: string,
    cookies: SerializedCookie[],
    tokens: HarvestedTokens,
  ): Promise<void> {
    await ScrapeSessionModel.updateOne(
      { sessionId },
      { $set: { cookies, harvestedTokens: tokens } },
    );
  }

  async delete(sessionId: string): Promise<void> {
    await ScrapeSessionModel.deleteOne({ sessionId });
  }
}

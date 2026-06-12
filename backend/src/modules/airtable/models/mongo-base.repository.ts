import { BaseModel } from './schemas/base.schema.js';
import type {
  IBaseRepository,
  BaseDocument,
  ProcessingStatus,
  ProcessingError,
} from './base.repository.interface.js';

function toDocument(doc: InstanceType<typeof BaseModel>): BaseDocument {
  return {
    airtableId: doc.airtableId,
    name: doc.name,
    permissionLevel: doc.permissionLevel,
    processingStatus: doc.processingStatus,
    processingErrors: doc.processingErrors,
    lastProcessedAt: doc.lastProcessedAt,
    lastSuccessfulAt: doc.lastSuccessfulAt,
  };
}

export class MongoBaseRepository implements IBaseRepository {
  async upsert(
    base: Pick<BaseDocument, 'airtableId' | 'name' | 'permissionLevel'>,
  ): Promise<BaseDocument> {
    const doc = await BaseModel.findOneAndUpdate(
      { airtableId: base.airtableId },
      { $setOnInsert: { processingStatus: 'idle', processingErrors: [] }, $set: { name: base.name, permissionLevel: base.permissionLevel } },
      { upsert: true, new: true },
    ).lean();

    if (!doc) throw new Error(`Upsert failed for base ${base.airtableId}`);
    return doc as BaseDocument;
  }

  async findById(airtableId: string): Promise<BaseDocument | null> {
    const doc = await BaseModel.findOne({ airtableId }).lean();
    return doc as BaseDocument | null;
  }

  async findAll(): Promise<BaseDocument[]> {
    const docs = await BaseModel.find().lean();
    return docs as BaseDocument[];
  }

  async findForProcessing(limit: number): Promise<BaseDocument[]> {
    // Prioritise idle/error bases, ordered by oldest lastProcessedAt (nulls first).
    const docs = await BaseModel.find({ processingStatus: { $ne: 'processing' } })
      .sort({ lastProcessedAt: 1 })
      .limit(limit)
      .lean();
    return docs as BaseDocument[];
  }

  async updateStatus(
    airtableId: string,
    status: ProcessingStatus,
    error?: ProcessingError,
  ): Promise<void> {
    const update: Record<string, unknown> = { $set: { processingStatus: status, lastProcessedAt: new Date() } };
    if (error) {
      update['$push'] = { processingErrors: error };
    }
    await BaseModel.updateOne({ airtableId }, update);
  }

  async markSuccessful(airtableId: string): Promise<void> {
    const now = new Date();
    await BaseModel.updateOne(
      { airtableId },
      {
        $set: {
          processingStatus: 'idle',
          lastProcessedAt: now,
          lastSuccessfulAt: now,
          processingErrors: [],
        },
      },
    );
  }

  async count(): Promise<number> {
    return BaseModel.countDocuments();
  }

  async resetAllForReprocessing(): Promise<void> {
    await BaseModel.updateMany(
      {},
      { $set: { processingStatus: 'idle', processingErrors: [], lastProcessedAt: null, lastSuccessfulAt: null } },
    );
  }
}

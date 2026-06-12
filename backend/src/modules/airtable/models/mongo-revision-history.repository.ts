import { RevisionHistoryModel } from './schemas/revision-history.schema.js';
import type {
  IRevisionHistoryRepository,
  RevisionHistoryDocument,
} from './revision-history.repository.interface.js';

export class MongoRevisionHistoryRepository implements IRevisionHistoryRepository {
  async upsert(revision: RevisionHistoryDocument): Promise<RevisionHistoryDocument> {
    const doc = await RevisionHistoryModel.findOneAndUpdate(
      { uuid: revision.uuid },
      { $set: revision },
      { upsert: true, new: true },
    ).lean();

    if (!doc) throw new Error(`Upsert failed for revision ${revision.uuid}`);
    return doc as RevisionHistoryDocument;
  }

  async upsertMany(revisions: RevisionHistoryDocument[]): Promise<void> {
    if (revisions.length === 0) return;

    const ops = revisions.map((r) => ({
      updateOne: {
        filter: { uuid: r.uuid },
        update: { $set: r },
        upsert: true,
      },
    }));

    await RevisionHistoryModel.bulkWrite(ops, { ordered: false });
  }

  async findByIssueId(issueId: string): Promise<RevisionHistoryDocument[]> {
    const docs = await RevisionHistoryModel.find({ issueId }).sort({ createdDate: 1 }).lean();
    return docs as RevisionHistoryDocument[];
  }

  async findAll(options?: { skip?: number; limit?: number }): Promise<RevisionHistoryDocument[]> {
    const query = RevisionHistoryModel.find().sort({ createdDate: -1 });
    if (options?.skip) query.skip(options.skip);
    if (options?.limit) query.limit(options.limit);
    const docs = await query.lean();
    return docs as RevisionHistoryDocument[];
  }

  async count(): Promise<number> {
    return RevisionHistoryModel.countDocuments();
  }
}

import { PageModel } from './schemas/page.schema.js';
import type { IPageRepository, PageDocument, RevisionStatus } from './page.repository.interface.js';

export class MongoPageRepository implements IPageRepository {
  async upsert(
    page: Pick<PageDocument, 'airtableId' | 'baseId' | 'tableId' | 'fields' | 'createdTime'>,
  ): Promise<PageDocument> {
    const doc = await PageModel.findOneAndUpdate(
      { airtableId: page.airtableId },
      {
        $set: {
          baseId: page.baseId,
          tableId: page.tableId,
          fields: page.fields,
          createdTime: page.createdTime,
        },
        $setOnInsert: { revisionStatus: 'pending', revisionScrapedAt: null },
      },
      { upsert: true, new: true },
    ).lean();

    if (!doc) throw new Error(`Upsert failed for page ${page.airtableId}`);
    return doc as PageDocument;
  }

  async findPendingRevision(baseId: string, limit: number): Promise<PageDocument[]> {
    const docs = await PageModel.find({ baseId, revisionStatus: { $in: ['pending', 'error'] } })
      .limit(limit)
      .lean();
    return docs as PageDocument[];
  }

  async findByTableId(tableId: string): Promise<PageDocument[]> {
    const docs = await PageModel.find({ tableId }).lean();
    return docs as PageDocument[];
  }

  async updateRevisionStatus(
    airtableId: string,
    status: RevisionStatus,
    scrapedAt?: Date,
  ): Promise<void> {
    const update: Record<string, unknown> = { revisionStatus: status };
    if (scrapedAt) update['revisionScrapedAt'] = scrapedAt;
    await PageModel.updateOne({ airtableId }, { $set: update });
  }

  async count(): Promise<number> {
    return PageModel.countDocuments();
  }
}

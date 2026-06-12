import { TableModel } from './schemas/table.schema.js';
import type { ITableRepository, TableDocument } from './table.repository.interface.js';

export class MongoTableRepository implements ITableRepository {
  async upsert(table: Omit<TableDocument, 'lastProcessedAt'>): Promise<TableDocument> {
    const doc = await TableModel.findOneAndUpdate(
      { airtableId: table.airtableId },
      {
        $set: {
          baseId: table.baseId,
          name: table.name,
          primaryFieldId: table.primaryFieldId,
          fields: table.fields,
        },
      },
      { upsert: true, new: true },
    ).lean();

    if (!doc) throw new Error(`Upsert failed for table ${table.airtableId}`);
    return doc as TableDocument;
  }

  async findByBaseId(baseId: string): Promise<TableDocument[]> {
    const docs = await TableModel.find({ baseId }).lean();
    return docs as TableDocument[];
  }

  async findById(airtableId: string): Promise<TableDocument | null> {
    const doc = await TableModel.findOne({ airtableId }).lean();
    return doc as TableDocument | null;
  }

  async markProcessed(airtableId: string): Promise<void> {
    await TableModel.updateOne({ airtableId }, { $set: { lastProcessedAt: new Date() } });
  }
}

import type { AirtableField } from '../api/airtable-api.service.interface.js';

export interface TableDocument {
  airtableId: string;
  baseId: string;
  name: string;
  primaryFieldId: string;
  fields: AirtableField[];
  lastProcessedAt: Date | null;
}

export interface ITableRepository {
  upsert(table: Omit<TableDocument, 'lastProcessedAt'>): Promise<TableDocument>;
  findByBaseId(baseId: string): Promise<TableDocument[]>;
  findById(airtableId: string): Promise<TableDocument | null>;
  markProcessed(airtableId: string): Promise<void>;
}

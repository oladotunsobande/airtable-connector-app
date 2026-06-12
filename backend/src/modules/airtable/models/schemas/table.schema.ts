import { Schema, model, type Document } from 'mongoose';
import type { TableDocument } from '../table.repository.interface.js';

export interface TableDoc extends TableDocument, Document {}

const fieldSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, required: true },
    options: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

export const tableSchema = new Schema<TableDoc>(
  {
    airtableId: { type: String, required: true, unique: true, index: true },
    baseId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    primaryFieldId: { type: String, required: true },
    fields: { type: [fieldSchema], default: [] },
    lastProcessedAt: { type: Date, default: null },
  },
  { timestamps: false },
);

export const TableModel = model<TableDoc>('Table', tableSchema, 'tables');

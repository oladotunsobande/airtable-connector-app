import { Schema, model, type Document } from 'mongoose';
import type { RevisionHistoryDocument } from '../revision-history.repository.interface.js';

export interface RevisionHistoryDoc extends RevisionHistoryDocument, Document {}

export const revisionHistorySchema = new Schema<RevisionHistoryDoc>(
  {
    uuid: { type: String, required: true, unique: true, index: true },
    issueId: { type: String, required: true, index: true },
    columnType: { type: String, required: true },
    oldValue: { type: String, default: null },
    newValue: { type: String, default: null },
    createdDate: { type: Date, required: true },
    authoredBy: { type: String, required: true },
  },
  { timestamps: false },
);

export const RevisionHistoryModel = model<RevisionHistoryDoc>(
  'RevisionHistory',
  revisionHistorySchema,
  'revisionHistory',
);

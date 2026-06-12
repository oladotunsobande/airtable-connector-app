import { Schema, model, type Document } from 'mongoose';
import type { PageDocument, RevisionStatus } from '../page.repository.interface.js';

export interface PageDoc extends PageDocument, Document {}

export const pageSchema = new Schema<PageDoc>(
  {
    airtableId: { type: String, required: true, unique: true, index: true },
    baseId: { type: String, required: true, index: true },
    tableId: { type: String, required: true, index: true },
    fields: { type: Schema.Types.Mixed, required: true },
    createdTime: { type: Date, required: true },
    revisionScrapedAt: { type: Date, default: null },
    revisionStatus: {
      type: String,
      enum: ['pending', 'scraped', 'error'] satisfies RevisionStatus[],
      default: 'pending',
      required: true,
    },
  },
  { timestamps: false },
);

// Compound index for efficient lookups by base + table
pageSchema.index({ baseId: 1, tableId: 1 });
// Index for fetching pages with pending revision scraping
pageSchema.index({ baseId: 1, revisionStatus: 1 });

export const PageModel = model<PageDoc>('Page', pageSchema, 'pages');

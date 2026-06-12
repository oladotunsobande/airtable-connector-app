import { Schema, model, type Document } from 'mongoose';
import type { BaseDocument, ProcessingError, ProcessingStatus } from '../base.repository.interface.js';

export interface BaseDoc extends BaseDocument, Document {}

const processingErrorSchema = new Schema<ProcessingError>(
  {
    message: { type: String, required: true },
    occurredAt: { type: Date, required: true },
  },
  { _id: false },
);

export const baseSchema = new Schema<BaseDoc>(
  {
    airtableId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    permissionLevel: { type: String, required: true },
    processingStatus: {
      type: String,
      enum: ['idle', 'queued', 'processing', 'error'] satisfies ProcessingStatus[],
      default: 'idle',
      required: true,
    },
    processingErrors: { type: [processingErrorSchema], default: [] },
    lastProcessedAt: { type: Date, default: null },
    lastSuccessfulAt: { type: Date, default: null },
  },
  { timestamps: false },
);

export const BaseModel = model<BaseDoc>('Base', baseSchema, 'bases');

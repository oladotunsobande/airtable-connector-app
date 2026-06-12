import { Schema, model, type Document } from 'mongoose';
import type { ScrapeSessionDocument, SessionState } from '../scrape-session.repository.interface.js';

export interface ScrapeSessionDoc extends ScrapeSessionDocument, Document {}

const cookieSchema = new Schema(
  {
    name: { type: String, required: true },
    value: { type: String, required: true },
    domain: { type: String, required: true },
    path: { type: String, required: true },
    expires: { type: Number, required: true },
    httpOnly: { type: Boolean, required: true },
    secure: { type: Boolean, required: true },
  },
  { _id: false },
);

const harvestedTokensSchema = new Schema(
  {
    secretSocketId: { type: String, required: true },
  },
  { _id: false },
);

export const scrapeSessionSchema = new Schema<ScrapeSessionDoc>(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    cookies: { type: [cookieSchema], default: [] },
    harvestedTokens: { type: harvestedTokensSchema, default: null },
    state: {
      type: String,
      enum: ['active', 'awaiting_mfa', 'expired', 'invalid'] satisfies SessionState[],
      required: true,
    },
    validatedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: false },
);

scrapeSessionSchema.index({ state: 1 });

export const ScrapeSessionModel = model<ScrapeSessionDoc>(
  'ScrapeSession',
  scrapeSessionSchema,
  'scrapeSessions',
);

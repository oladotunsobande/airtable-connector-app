import { Schema, model, type Document } from 'mongoose';
import type { TokenSet } from '../oauth.service.interface.js';

export interface OAuthTokenDoc extends TokenSet, Document {}

export const oauthTokenSchema = new Schema<OAuthTokenDoc>(
  {
    // Stored encrypted — the repository layer handles encrypt/decrypt.
    accessToken: { type: String, required: true },
    refreshToken: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    scope: { type: String, required: true },
    tokenType: { type: String, required: true },
  },
  { timestamps: true },
);

export const OAuthTokenModel = model<OAuthTokenDoc>('OAuthToken', oauthTokenSchema, 'oauthTokens');

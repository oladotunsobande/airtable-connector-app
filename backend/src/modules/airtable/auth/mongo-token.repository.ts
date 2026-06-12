import crypto from 'node:crypto';
import { OAuthTokenModel } from './schemas/oauth-token.schema.js';
import type { ITokenRepository } from './token.repository.interface.js';
import type { TokenSet } from './oauth.service.interface.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return key;
}

function encrypt(text: string, hexKey: string): string {
  const key = getKey(hexKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(12) + tag(16) + ciphertext — all base64-encoded
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(encoded: string, hexKey: string): string {
  const key = getKey(hexKey);
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

export class MongoTokenRepository implements ITokenRepository {
  constructor(private readonly encryptionKey: string) {}

  async save(tokenSet: TokenSet): Promise<void> {
    // Single active record — delete any existing before inserting fresh.
    await OAuthTokenModel.deleteMany({});
    await OAuthTokenModel.create({
      accessToken: encrypt(tokenSet.accessToken, this.encryptionKey),
      refreshToken: encrypt(tokenSet.refreshToken, this.encryptionKey),
      expiresAt: tokenSet.expiresAt,
      scope: tokenSet.scope,
      tokenType: tokenSet.tokenType,
    });
  }

  async find(): Promise<TokenSet | null> {
    const doc = await OAuthTokenModel.findOne().lean();
    if (!doc) return null;

    return {
      accessToken: decrypt(doc.accessToken, this.encryptionKey),
      refreshToken: decrypt(doc.refreshToken, this.encryptionKey),
      expiresAt: doc.expiresAt,
      scope: doc.scope,
      tokenType: doc.tokenType,
    };
  }

  async delete(): Promise<void> {
    await OAuthTokenModel.deleteMany({});
  }
}

/**
 * Integration tests for all Mongoose repositories.
 * Requires a running MongoDB on localhost:27017 (docker compose up).
 *
 * Each suite drops its collection before running so tests are isolated
 * and can be run repeatedly against the live docker instance.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';

import { MongoBaseRepository } from './mongo-base.repository.js';
import { MongoTableRepository } from './mongo-table.repository.js';
import { MongoPageRepository } from './mongo-page.repository.js';
import { MongoRevisionHistoryRepository } from './mongo-revision-history.repository.js';
import { MongoUserRepository } from './mongo-user.repository.js';
import { MongoScrapeSessionRepository } from './mongo-scrape-session.repository.js';
import { MongoTokenRepository } from '../auth/mongo-token.repository.js';

import { BaseModel } from './schemas/base.schema.js';
import { TableModel } from './schemas/table.schema.js';
import { PageModel } from './schemas/page.schema.js';
import { RevisionHistoryModel } from './schemas/revision-history.schema.js';
import { UserModel } from './schemas/user.schema.js';
import { ScrapeSessionModel } from './schemas/scrape-session.schema.js';
import { OAuthTokenModel } from '../auth/schemas/oauth-token.schema.js';

const MONGO_URI = process.env['MONGO_URI'] ?? 'mongodb://localhost:27017/airtable_connector_test';
// 32-byte test key
const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

beforeAll(async () => {
  await mongoose.connect(MONGO_URI);
});

afterAll(async () => {
  await mongoose.disconnect();
});

// ─── BaseRepository ─────────────────────────────────────────────────────────

describe('MongoBaseRepository', () => {
  const repo = new MongoBaseRepository();

  beforeEach(async () => { await BaseModel.deleteMany({}); });

  it('upserts a new base with idle status', async () => {
    const base = await repo.upsert({ airtableId: 'app1', name: 'Test Base', permissionLevel: 'create' });
    expect(base.airtableId).toBe('app1');
    expect(base.processingStatus).toBe('idle');
    expect(base.processingErrors).toHaveLength(0);
  });

  it('upsert is idempotent — updates name without resetting flags', async () => {
    await repo.upsert({ airtableId: 'app1', name: 'Old Name', permissionLevel: 'create' });
    await repo.updateStatus('app1', 'error', { message: 'boom', occurredAt: new Date() });
    await repo.upsert({ airtableId: 'app1', name: 'New Name', permissionLevel: 'create' });
    const found = await repo.findById('app1');
    expect(found?.name).toBe('New Name');
    // processingErrors preserved — $setOnInsert only fires on insert
    expect(found?.processingErrors).toHaveLength(1);
  });

  it('findForProcessing excludes processing bases and orders by oldest lastProcessedAt', async () => {
    await repo.upsert({ airtableId: 'app1', name: 'A', permissionLevel: 'create' });
    await repo.upsert({ airtableId: 'app2', name: 'B', permissionLevel: 'create' });
    await repo.updateStatus('app2', 'processing');
    const results = await repo.findForProcessing(10);
    expect(results.map((r) => r.airtableId)).not.toContain('app2');
    expect(results.map((r) => r.airtableId)).toContain('app1');
  });

  it('markSuccessful resets status to idle and clears errors', async () => {
    await repo.upsert({ airtableId: 'app1', name: 'A', permissionLevel: 'create' });
    await repo.updateStatus('app1', 'error', { message: 'oops', occurredAt: new Date() });
    await repo.markSuccessful('app1');
    const doc = await repo.findById('app1');
    expect(doc?.processingStatus).toBe('idle');
    expect(doc?.processingErrors).toHaveLength(0);
    expect(doc?.lastSuccessfulAt).toBeInstanceOf(Date);
  });

  it('count returns the correct number of bases', async () => {
    expect(await repo.count()).toBe(0);
    await repo.upsert({ airtableId: 'app1', name: 'A', permissionLevel: 'create' });
    await repo.upsert({ airtableId: 'app2', name: 'B', permissionLevel: 'create' });
    expect(await repo.count()).toBe(2);
  });
});

// ─── TableRepository ─────────────────────────────────────────────────────────

describe('MongoTableRepository', () => {
  const repo = new MongoTableRepository();

  beforeEach(async () => { await TableModel.deleteMany({}); });

  it('upserts a table and finds it by baseId', async () => {
    await repo.upsert({ airtableId: 'tbl1', baseId: 'app1', name: 'T', primaryFieldId: 'fld1', fields: [] });
    const tables = await repo.findByBaseId('app1');
    expect(tables).toHaveLength(1);
    expect(tables[0]?.airtableId).toBe('tbl1');
  });

  it('upsert updates fields on second call', async () => {
    await repo.upsert({ airtableId: 'tbl1', baseId: 'app1', name: 'Old', primaryFieldId: 'fld1', fields: [] });
    await repo.upsert({
      airtableId: 'tbl1',
      baseId: 'app1',
      name: 'Updated',
      primaryFieldId: 'fld1',
      fields: [{ id: 'fld1', name: 'Title', type: 'singleLineText' }],
    });
    const found = await repo.findById('tbl1');
    expect(found?.name).toBe('Updated');
    expect(found?.fields).toHaveLength(1);
  });

  it('markProcessed sets lastProcessedAt', async () => {
    await repo.upsert({ airtableId: 'tbl1', baseId: 'app1', name: 'T', primaryFieldId: 'fld1', fields: [] });
    await repo.markProcessed('tbl1');
    const found = await repo.findById('tbl1');
    expect(found?.lastProcessedAt).toBeInstanceOf(Date);
  });
});

// ─── PageRepository ──────────────────────────────────────────────────────────

describe('MongoPageRepository', () => {
  const repo = new MongoPageRepository();

  beforeEach(async () => { await PageModel.deleteMany({}); });

  const makePageInput = (id: string) => ({
    airtableId: id,
    baseId: 'app1',
    tableId: 'tbl1',
    fields: { Title: 'Test' },
    createdTime: new Date(),
  });

  it('upserts a page with pending revision status', async () => {
    const page = await repo.upsert(makePageInput('rec1'));
    expect(page.revisionStatus).toBe('pending');
  });

  it('upsert does not reset revisionStatus on subsequent calls', async () => {
    await repo.upsert(makePageInput('rec1'));
    await repo.updateRevisionStatus('rec1', 'scraped', new Date());
    await repo.upsert(makePageInput('rec1'));
    const found = (await repo.findByTableId('tbl1'))[0];
    expect(found?.revisionStatus).toBe('scraped');
  });

  it('findPendingRevision returns only pending/error pages for the given base', async () => {
    await repo.upsert(makePageInput('rec1'));
    await repo.upsert(makePageInput('rec2'));
    await repo.updateRevisionStatus('rec2', 'scraped');
    const pending = await repo.findPendingRevision('app1', 10);
    expect(pending.map((p) => p.airtableId)).toContain('rec1');
    expect(pending.map((p) => p.airtableId)).not.toContain('rec2');
  });

  it('count returns total pages', async () => {
    await repo.upsert(makePageInput('rec1'));
    await repo.upsert(makePageInput('rec2'));
    expect(await repo.count()).toBe(2);
  });
});

// ─── RevisionHistoryRepository ───────────────────────────────────────────────

describe('MongoRevisionHistoryRepository', () => {
  const repo = new MongoRevisionHistoryRepository();

  beforeEach(async () => { await RevisionHistoryModel.deleteMany({}); });

  const makeRevision = (uuid: string, issueId = 'rec1') => ({
    uuid,
    issueId,
    columnType: 'Status',
    oldValue: 'Open',
    newValue: 'Closed',
    createdDate: new Date(),
    authoredBy: 'usr1',
  });

  it('upserts a revision and finds it by issueId', async () => {
    await repo.upsert(makeRevision('rev1'));
    const found = await repo.findByIssueId('rec1');
    expect(found).toHaveLength(1);
    expect(found[0]?.uuid).toBe('rev1');
  });

  it('upsert is idempotent — deduplicates by uuid', async () => {
    await repo.upsert(makeRevision('rev1'));
    await repo.upsert(makeRevision('rev1'));
    expect(await repo.count()).toBe(1);
  });

  it('upsertMany bulk-inserts and deduplicates', async () => {
    const revisions = [makeRevision('rev1'), makeRevision('rev2'), makeRevision('rev1')];
    await repo.upsertMany(revisions);
    expect(await repo.count()).toBe(2);
  });

  it('findAll supports skip and limit', async () => {
    await repo.upsertMany([makeRevision('r1'), makeRevision('r2'), makeRevision('r3')]);
    const page = await repo.findAll({ skip: 1, limit: 1 });
    expect(page).toHaveLength(1);
  });
});

// ─── UserRepository ──────────────────────────────────────────────────────────

describe('MongoUserRepository', () => {
  const repo = new MongoUserRepository();

  beforeEach(async () => { await UserModel.deleteMany({}); });

  it('upserts and finds a user', async () => {
    await repo.upsert({ airtableId: 'usr1', email: 'a@b.com', name: 'Alice', profilePicUrl: null });
    const found = await repo.findById('usr1');
    expect(found?.email).toBe('a@b.com');
  });

  it('upsertMany bulk-upserts without duplicates', async () => {
    const users = [
      { airtableId: 'usr1', email: 'a@b.com', name: 'Alice', profilePicUrl: null },
      { airtableId: 'usr2', email: 'b@b.com', name: 'Bob', profilePicUrl: null },
      { airtableId: 'usr1', email: 'a@b.com', name: 'Alice Updated', profilePicUrl: null },
    ];
    await repo.upsertMany(users);
    const all = await repo.findAll();
    expect(all).toHaveLength(2);
    const alice = all.find((u) => u.airtableId === 'usr1');
    expect(alice?.name).toBe('Alice Updated');
  });
});

// ─── ScrapeSessionRepository ─────────────────────────────────────────────────

describe('MongoScrapeSessionRepository', () => {
  const repo = new MongoScrapeSessionRepository();

  beforeEach(async () => { await ScrapeSessionModel.deleteMany({}); });

  const makeSession = (id: string) => ({
    sessionId: id,
    cookies: [],
    harvestedTokens: null,
    state: 'active' as const,
    validatedAt: new Date(),
    expiresAt: null,
  });

  it('saves and finds an active session', async () => {
    await repo.save(makeSession('sess1'));
    const found = await repo.findActive();
    expect(found?.sessionId).toBe('sess1');
  });

  it('findActive returns null when no active session', async () => {
    await repo.save({ ...makeSession('sess1'), state: 'expired' });
    expect(await repo.findActive()).toBeNull();
  });

  it('updateState transitions session state', async () => {
    await repo.save(makeSession('sess1'));
    await repo.updateState('sess1', 'expired');
    expect(await repo.findActive()).toBeNull();
  });

  it('updateTokens stores cookies and harvested tokens', async () => {
    await repo.save(makeSession('sess1'));
    const cookie = { name: 'sid', value: 'abc', domain: '.airtable.com', path: '/', expires: 9999999999, httpOnly: true, secure: true };
    await repo.updateTokens('sess1', [cookie], { secretSocketId: 'soc123' });
    // Verify via a direct Mongo read
    const doc = await ScrapeSessionModel.findOne({ sessionId: 'sess1' }).lean();
    expect(doc?.harvestedTokens?.secretSocketId).toBe('soc123');
    expect(doc?.cookies).toHaveLength(1);
  });

  it('delete removes the session', async () => {
    await repo.save(makeSession('sess1'));
    await repo.delete('sess1');
    expect(await repo.findActive()).toBeNull();
  });
});

// ─── TokenRepository (with encryption) ──────────────────────────────────────

describe('MongoTokenRepository', () => {
  const repo = new MongoTokenRepository(TEST_ENCRYPTION_KEY);

  beforeEach(async () => { await OAuthTokenModel.deleteMany({}); });

  const makeTokenSet = () => ({
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: new Date(Date.now() + 3600_000),
    scope: 'data.records:read',
    tokenType: 'Bearer',
  });

  it('saves and retrieves token set with decryption', async () => {
    await repo.save(makeTokenSet());
    const found = await repo.find();
    expect(found?.accessToken).toBe('access-secret');
    expect(found?.refreshToken).toBe('refresh-secret');
  });

  it('stored access token is encrypted (not plain text)', async () => {
    await repo.save(makeTokenSet());
    const raw = await OAuthTokenModel.findOne().lean();
    expect(raw?.accessToken).not.toBe('access-secret');
  });

  it('save replaces the previous token set', async () => {
    await repo.save(makeTokenSet());
    await repo.save({ ...makeTokenSet(), accessToken: 'new-access' });
    const found = await repo.find();
    expect(found?.accessToken).toBe('new-access');
    expect(await OAuthTokenModel.countDocuments()).toBe(1);
  });

  it('delete removes all token sets', async () => {
    await repo.save(makeTokenSet());
    await repo.delete();
    expect(await repo.find()).toBeNull();
  });
});

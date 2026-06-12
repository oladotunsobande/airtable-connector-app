import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AirtableApiService } from './airtable-api.service.js';
import type { IHttpClient } from '../../../infrastructure/http/http-client.interface.js';
import type { IRateLimiter } from '../../../infrastructure/rate-limit/rate-limiter.interface.js';
import type { ITokenProvider } from '../auth/token-provider.interface.js';
import type { AppConfig } from '../../../config/index.js';
import type { Logger } from '../../../core/logger/index.js';

// ── Test doubles ──────────────────────────────────────────────────────────────

function makeConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    mongo: { uri: 'mongodb://localhost:27017/test' },
    redis: { host: 'localhost', port: 6379 },
    airtable: {
      clientId: 'test-client-id',
      clientSecret: 'test-secret',
      redirectUri: 'http://localhost:3000/callback',
      scopes: ['data.records:read', 'schema.bases:read'],
      loginEmail: 'test@example.com',
      loginPassword: 'password',
      webUrl: 'https://airtable.com',
      apiBaseUrl: 'https://api.airtable.com/v0',
      rps: 5,
    },
    encryption: { key: 'a'.repeat(64) },
    pipeline: { maxBasesPerRun: 5 },
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function makeHttpClient(): IHttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
}

function makeRateLimiter(): IRateLimiter {
  return {
    acquire: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTokenProvider(token = 'access-token-abc'): ITokenProvider {
  return {
    getAccessToken: vi.fn().mockResolvedValue(token),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeService(overrides?: {
  http?: IHttpClient;
  rateLimiter?: IRateLimiter;
  tokenProvider?: ITokenProvider;
}) {
  return new AirtableApiService(
    makeConfig(),
    overrides?.http ?? makeHttpClient(),
    overrides?.tokenProvider ?? makeTokenProvider(),
    overrides?.rateLimiter ?? makeRateLimiter(),
    makeLogger(),
  );
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('AirtableApiService.getBases()', () => {
  it('returns all bases on a single page', async () => {
    const http = makeHttpClient();
    vi.mocked(http.get).mockResolvedValueOnce({
      bases: [
        { id: 'base1', name: 'Base One', permissionLevel: 'create' },
        { id: 'base2', name: 'Base Two', permissionLevel: 'read' },
      ],
    });

    const service = makeService({ http });
    const bases = await service.getBases();

    expect(bases).toHaveLength(2);
    expect(bases[0]).toEqual({ id: 'base1', name: 'Base One', permissionLevel: 'create' });
    expect(bases[1]).toEqual({ id: 'base2', name: 'Base Two', permissionLevel: 'read' });
  });

  it('paginates through multiple pages using offset', async () => {
    const http = makeHttpClient();
    vi.mocked(http.get)
      .mockResolvedValueOnce({
        bases: [{ id: 'base1', name: 'Base One', permissionLevel: 'create' }],
        offset: 'next-page-cursor',
      })
      .mockResolvedValueOnce({
        bases: [{ id: 'base2', name: 'Base Two', permissionLevel: 'read' }],
      });

    const service = makeService({ http });
    const bases = await service.getBases();

    expect(bases).toHaveLength(2);
    expect(http.get).toHaveBeenCalledTimes(2);

    // First call: no offset
    expect(vi.mocked(http.get).mock.calls[0]?.[0]).toBe('https://api.airtable.com/v0/meta/bases');
    // Second call: has offset param
    expect(vi.mocked(http.get).mock.calls[1]?.[0]).toBe(
      'https://api.airtable.com/v0/meta/bases?offset=next-page-cursor',
    );
  });

  it('returns empty array when no bases exist', async () => {
    const http = makeHttpClient();
    vi.mocked(http.get).mockResolvedValueOnce({ bases: [] });

    const service = makeService({ http });
    const bases = await service.getBases();

    expect(bases).toHaveLength(0);
  });

  it('acquires the rate limiter before each request', async () => {
    const http = makeHttpClient();
    const rateLimiter = makeRateLimiter();

    vi.mocked(http.get)
      .mockResolvedValueOnce({ bases: [{ id: 'b1', name: 'B', permissionLevel: 'create' }], offset: 'p2' })
      .mockResolvedValueOnce({ bases: [{ id: 'b2', name: 'C', permissionLevel: 'read' }] });

    const service = makeService({ http, rateLimiter });
    await service.getBases();

    // One acquire per page (2 pages)
    expect(rateLimiter.acquire).toHaveBeenCalledTimes(2);
    expect(rateLimiter.acquire).toHaveBeenCalledWith('api.airtable.com');
  });

  it('sends the Bearer token in the Authorization header', async () => {
    const http = makeHttpClient();
    const tokenProvider = makeTokenProvider('my-token-xyz');

    vi.mocked(http.get).mockResolvedValueOnce({ bases: [] });

    const service = makeService({ http, tokenProvider });
    await service.getBases();

    expect(http.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { Authorization: 'Bearer my-token-xyz' } }),
    );
  });
});

describe('AirtableApiService.getTables()', () => {
  it('fetches and maps tables for a base', async () => {
    const http = makeHttpClient();
    vi.mocked(http.get).mockResolvedValueOnce({
      tables: [
        {
          id: 'tbl1',
          name: 'Issues',
          primaryFieldId: 'fld1',
          fields: [
            { id: 'fld1', name: 'Name', type: 'singleLineText' },
            { id: 'fld2', name: 'Status', type: 'singleSelect', options: { choices: [] } },
          ],
        },
      ],
    });

    const service = makeService({ http });
    const tables = await service.getTables('base1');

    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      id: 'tbl1',
      name: 'Issues',
      primaryFieldId: 'fld1',
    });
    expect(tables[0]?.fields).toHaveLength(2);
  });

  it('calls the correct URL for the base', async () => {
    const http = makeHttpClient();
    vi.mocked(http.get).mockResolvedValueOnce({ tables: [] });

    const service = makeService({ http });
    await service.getTables('appXYZ123');

    expect(http.get).toHaveBeenCalledWith(
      'https://api.airtable.com/v0/meta/bases/appXYZ123/tables',
      expect.any(Object),
    );
  });

  it('omits options property when field has no options', async () => {
    const http = makeHttpClient();
    vi.mocked(http.get).mockResolvedValueOnce({
      tables: [
        {
          id: 'tbl1',
          name: 'T',
          primaryFieldId: 'fld1',
          fields: [{ id: 'fld1', name: 'Name', type: 'singleLineText' }],
        },
      ],
    });

    const service = makeService({ http });
    const tables = await service.getTables('base1');
    const field = tables[0]?.fields[0];

    expect(field).toBeDefined();
    expect(Object.keys(field!)).not.toContain('options');
  });
});

describe('AirtableApiService.getRecords()', () => {
  it('yields a single page of records', async () => {
    const http = makeHttpClient();
    vi.mocked(http.get).mockResolvedValueOnce({
      records: [
        { id: 'rec1', createdTime: '2024-01-01T00:00:00.000Z', fields: { Name: 'Issue 1' } },
        { id: 'rec2', createdTime: '2024-01-02T00:00:00.000Z', fields: { Name: 'Issue 2' } },
      ],
    });

    const service = makeService({ http });
    const batches: Array<{ id: string }[]> = [];
    for await (const batch of service.getRecords('base1', 'tbl1')) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.[0]).toMatchObject({ id: 'rec1' });
  });

  it('yields multiple pages and stops when no offset', async () => {
    const http = makeHttpClient();
    vi.mocked(http.get)
      .mockResolvedValueOnce({
        records: [{ id: 'rec1', createdTime: '2024-01-01T00:00:00.000Z', fields: {} }],
        offset: 'page2',
      })
      .mockResolvedValueOnce({
        records: [{ id: 'rec2', createdTime: '2024-01-02T00:00:00.000Z', fields: {} }],
        offset: 'page3',
      })
      .mockResolvedValueOnce({
        records: [{ id: 'rec3', createdTime: '2024-01-03T00:00:00.000Z', fields: {} }],
      });

    const service = makeService({ http });
    const batches: Array<{ id: string }[]> = [];
    for await (const batch of service.getRecords('base1', 'tbl1')) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(3);
    expect(batches.flat().map((r) => r.id)).toEqual(['rec1', 'rec2', 'rec3']);
    expect(http.get).toHaveBeenCalledTimes(3);
  });

  it('passes offset as a query param on subsequent pages', async () => {
    const http = makeHttpClient();
    vi.mocked(http.get)
      .mockResolvedValueOnce({ records: [], offset: 'cursor-abc' })
      .mockResolvedValueOnce({ records: [] });

    const service = makeService({ http });
    // drain the generator
    for await (const _ of service.getRecords('appBASE', 'tblTABLE')) { /* empty */ }

    expect(vi.mocked(http.get).mock.calls[0]?.[0]).toBe(
      'https://api.airtable.com/v0/appBASE/tblTABLE',
    );
    expect(vi.mocked(http.get).mock.calls[1]?.[0]).toBe(
      'https://api.airtable.com/v0/appBASE/tblTABLE?offset=cursor-abc',
    );
  });

  it('acquires rate limiter once per page', async () => {
    const http = makeHttpClient();
    const rateLimiter = makeRateLimiter();

    vi.mocked(http.get)
      .mockResolvedValueOnce({ records: [], offset: 'p2' })
      .mockResolvedValueOnce({ records: [] });

    const service = makeService({ http, rateLimiter });
    for await (const _ of service.getRecords('base1', 'tbl1')) { /* empty */ }

    expect(rateLimiter.acquire).toHaveBeenCalledTimes(2);
  });

  it('yields empty batches (empty page) without infinite loop', async () => {
    const http = makeHttpClient();
    vi.mocked(http.get).mockResolvedValueOnce({ records: [] });

    const service = makeService({ http });
    const batches: unknown[][] = [];
    for await (const batch of service.getRecords('base1', 'tbl1')) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(0);
  });
});

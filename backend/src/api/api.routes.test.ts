import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { HttpServer } from './http-server.js';
import type { IEntitiesService, EntityMeta, EntityPage } from './entities/entities.service.interface.js';
import type { ITokenProvider } from '../modules/airtable/auth/token-provider.interface.js';
import type { AppConfig } from '../config/index.js';

// ── Minimal stubs ─────────────────────────────────────────────────────────────

function makeConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    mongo: { uri: '' },
    redis: { host: 'localhost', port: 6379 },
    airtable: {
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'http://localhost:3000/callback',
      scopes: [],
      loginEmail: 'e@e.com',
      loginPassword: 'pw',
      webUrl: 'https://airtable.com',
      apiBaseUrl: 'https://api.airtable.com/v0',
      rps: 5,
    },
    encryption: { key: 'k' },
    pipeline: { maxBasesPerRun: 5 },
  };
}

function makeTokenProvider(connected: boolean): ITokenProvider {
  return {
    getAccessToken: vi.fn().mockResolvedValue('tok'),
    isConnected: vi.fn().mockResolvedValue(connected),
  };
}

function makeEntitiesService(
  entities: EntityMeta[],
  page: EntityPage,
): IEntitiesService {
  return {
    listEntities: vi.fn().mockResolvedValue(entities),
    queryEntity: vi.fn().mockResolvedValue(page),
  };
}

const SAMPLE_ENTITIES: EntityMeta[] = [
  { name: 'bases', label: 'Bases', count: 3 },
  { name: 'tables', label: 'Tables', count: 7 },
  { name: 'pages', label: 'Pages', count: 120 },
  { name: 'revisionHistory', label: 'Revision History', count: 450 },
  { name: 'users', label: 'Users', count: 8 },
];

const SAMPLE_PAGE: EntityPage = {
  data: [{ airtableId: 'abc', name: 'Base 1', permissionLevel: 'create' }],
  total: 3,
  page: 1,
  pageSize: 50,
  fields: ['airtableId', 'name', 'permissionLevel'],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp(opts: {
  connected?: boolean;
  entitiesService?: IEntitiesService;
}) {
  const server = new HttpServer({
    config: makeConfig(),
    oauthService: {
      buildAuthorizationUrl: vi.fn().mockReturnValue({ url: 'http://airtable.com/oauth', codeVerifier: 'cv', state: 'st' }),
      exchangeCode: vi.fn(),
      refreshToken: vi.fn(),
    },
    tokenProvider: makeTokenProvider(opts.connected ?? true),
    tokenRepository: { save: vi.fn(), load: vi.fn(), delete: vi.fn() },
    entitiesService: opts.entitiesService,
    log: {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as never,
  });
  return server.getApp();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /integrations', () => {
  it('returns airtable connected=true when token exists', async () => {
    const app = buildApp({ connected: true });
    const res = await request(app).get('/integrations');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'airtable', name: 'Airtable', connected: true }]);
  });

  it('returns airtable connected=false when no token', async () => {
    const app = buildApp({ connected: false });
    const res = await request(app).get('/integrations');

    expect(res.status).toBe(200);
    expect(res.body[0].connected).toBe(false);
  });
});

describe('GET /entities', () => {
  it('returns entity list from service', async () => {
    const svc = makeEntitiesService(SAMPLE_ENTITIES, SAMPLE_PAGE);
    const app = buildApp({ entitiesService: svc });
    const res = await request(app).get('/entities');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
    expect(res.body[0]).toEqual({ name: 'bases', label: 'Bases', count: 3 });
  });

  it('returns placeholder list with count 0 when service not configured', async () => {
    const app = buildApp({});
    const res = await request(app).get('/entities');

    expect(res.status).toBe(200);
    expect(res.body.every((e: { count: number }) => e.count === 0)).toBe(true);
  });
});

describe('GET /entities/:name/data', () => {
  let svc: IEntitiesService;
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    svc = makeEntitiesService(SAMPLE_ENTITIES, SAMPLE_PAGE);
    app = buildApp({ entitiesService: svc });
  });

  it('returns paginated data for a known entity', async () => {
    const res = await request(app).get('/entities/bases/data');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      data: expect.any(Array),
      total: 3,
      page: 1,
      pageSize: 50,
      fields: expect.any(Array),
    });
  });

  it('returns 404 for unknown entity', async () => {
    const res = await request(app).get('/entities/nonexistent/data');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('forwards page and pageSize query params', async () => {
    await request(app).get('/entities/bases/data?page=2&pageSize=10');

    expect(svc.queryEntity).toHaveBeenCalledWith(
      'bases',
      expect.objectContaining({ page: 2, pageSize: 10 }),
    );
  });

  it('forwards search query param', async () => {
    await request(app).get('/entities/bases/data?search=hello');

    expect(svc.queryEntity).toHaveBeenCalledWith(
      'bases',
      expect.objectContaining({ search: 'hello' }),
    );
  });

  it('forwards sort params', async () => {
    await request(app).get('/entities/bases/data?sortField=name&sortDir=asc');

    expect(svc.queryEntity).toHaveBeenCalledWith(
      'bases',
      expect.objectContaining({ sortField: 'name', sortDir: 'asc' }),
    );
  });

  it('forwards valid filterOp and ignores invalid ones', async () => {
    await request(app).get('/entities/bases/data?filterField=name&filterOp=contains&filterValue=foo');

    expect(svc.queryEntity).toHaveBeenCalledWith(
      'bases',
      expect.objectContaining({ filterField: 'name', filterOp: 'contains', filterValue: 'foo' }),
    );
  });

  it('rejects invalid filterOp and omits it', async () => {
    await request(app).get('/entities/bases/data?filterField=name&filterOp=invalid&filterValue=foo');

    expect(svc.queryEntity).toHaveBeenCalledWith(
      'bases',
      expect.not.objectContaining({ filterOp: 'invalid' }),
    );
  });

  it('caps pageSize at 200', async () => {
    await request(app).get('/entities/bases/data?pageSize=999');

    expect(svc.queryEntity).toHaveBeenCalledWith(
      'bases',
      expect.objectContaining({ pageSize: 200 }),
    );
  });

  it('returns 503 when service is not configured', async () => {
    const noSvcApp = buildApp({});
    const res = await request(noSvcApp).get('/entities/bases/data');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('ENTITIES_UNAVAILABLE');
  });
});

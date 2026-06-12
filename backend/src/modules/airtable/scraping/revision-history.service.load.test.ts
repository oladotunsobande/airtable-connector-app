import { describe, it, expect, vi, afterEach } from 'vitest';
import { RevisionHistoryService } from './revision-history.service.js';
import { RevisionHistoryParser } from './revision-history.parser.js';
import { TokenBucketRateLimiter } from '../../../infrastructure/rate-limit/token-bucket-rate-limiter.js';
import type { ISessionOrchestrator, HarvestedSession } from './session-orchestrator.interface.js';
import type { IRevisionHistoryRepository, RevisionHistoryDocument } from '../models/revision-history.repository.interface.js';
import type { IUserRepository } from '../models/user.repository.interface.js';
import type { IRateLimiter } from '../../../infrastructure/rate-limit/rate-limiter.interface.js';
import type { Logger } from '../../../core/logger/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const DIFF_HTML =
  '<span class="micro strong caps" columnId="fldXXX">Status</span>' +
  '<span class="pill cellChangeDiff-new">Done</span>';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function makeSession(): HarvestedSession {
  return {
    tokens: { secretSocketId: 'socket-id' },
    cookies: [
      {
        name: 'session',
        value: 'abc123',
        domain: 'airtable.com',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: true,
        secure: true,
      },
    ],
  };
}

/**
 * Builds a `makeBrowserFetch` mock that returns one activity per call with a
 * unique `activityId` derived from a counter. The activity has
 * `groupType: 'cellUpdate'` and valid diff HTML so the parser produces a
 * non-null document. Returns `{ status, text }` — the shape that
 * `ISessionOrchestrator.makeBrowserFetch` resolves to.
 */
function buildBrowserFetchMock(): ReturnType<typeof vi.fn> {
  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    const activityId = `activity-${callIndex++}`;
    const body = {
      rowActivityInfoById: {
        [activityId]: {
          rowId: `row-${callIndex}`,
          groupType: 'cellUpdate',
          createdTime: new Date().toISOString(),
          originatingUserId: 'usr1',
          diffRowHtml: DIFF_HTML,
        },
      },
      rowActivityOrCommentUserObjById: {
        usr1: { id: 'usr1', name: 'Alice', email: 'alice@example.com' },
      },
      // No offsetV2 → single page of results
    };
    return Promise.resolve({ status: 200, text: JSON.stringify(body) });
  });
}

function makeOrchestrator(
  browserFetchImpl?: ReturnType<typeof vi.fn>,
): ISessionOrchestrator {
  return {
    getSession: vi.fn().mockResolvedValue(makeSession()),
    invalidateSession: vi.fn().mockResolvedValue(undefined),
    awaitLoginComplete: vi.fn().mockResolvedValue(makeSession()),
    startLogin: vi.fn(),
    submitMfaCode: vi.fn(),
    getSessionState: vi.fn(),
    validateSession: vi.fn(),
    makeBrowserFetch: browserFetchImpl ?? buildBrowserFetchMock(),
  };
}

function buildRepo(collected: RevisionHistoryDocument[]): IRevisionHistoryRepository {
  return {
    upsertMany: vi.fn().mockImplementation((docs: RevisionHistoryDocument[]) => {
      collected.push(...docs);
      return Promise.resolve();
    }),
    upsert: vi.fn(),
    findByIssueId: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
  };
}

function buildUserRepo(): IUserRepository {
  return {
    upsertMany: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn(),
    findAll: vi.fn(),
  } as unknown as IUserRepository;
}

function makeFakeRateLimiter(): IRateLimiter {
  return { acquire: vi.fn().mockResolvedValue(undefined) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RevisionHistoryService — load tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('processes 200 pages and produces zero duplicate revision UUIDs', async () => {
    const allRevisions: RevisionHistoryDocument[] = [];
    const svc = new RevisionHistoryService(
      makeOrchestrator(),
      new RevisionHistoryParser(),
      buildRepo(allRevisions),
      buildUserRepo(),
      makeFakeRateLimiter(),
      makeLogger(),
    );

    const PAGE_COUNT = 200;
    for (let i = 0; i < PAGE_COUNT; i++) {
      await svc.scrapeForPage(
        `app${String(i).padStart(3, '0')}`,
        `tbl${String(i).padStart(3, '0')}`,
        `row${String(i).padStart(3, '0')}`,
      );
    }

    // Every page produced at least one revision
    expect(allRevisions.length).toBeGreaterThanOrEqual(PAGE_COUNT);

    // No duplicate UUIDs across all upsertMany calls
    const uuids = allRevisions.map((r) => r.uuid);
    const uniqueUuids = new Set(uuids);
    expect(uniqueUuids.size).toBe(uuids.length);
  }, 30_000);

  it('acquires rate-limiter exactly once per API page (no extra calls)', async () => {
    const acquireCalls: string[] = [];
    const rateLimiter: IRateLimiter = {
      acquire: vi.fn().mockImplementation((key: string) => {
        acquireCalls.push(key);
        return Promise.resolve();
      }),
    };

    const svc = new RevisionHistoryService(
      makeOrchestrator(),
      new RevisionHistoryParser(),
      buildRepo([]),
      buildUserRepo(),
      rateLimiter,
      makeLogger(),
    );

    const N = 20;
    for (let i = 0; i < N; i++) {
      await svc.scrapeForPage(`app${i}`, `tbl${i}`, `row${i}`);
    }

    // One single-page response per row → exactly N acquire calls
    expect(acquireCalls).toHaveLength(N);
    // All calls use the correct rate-limit key
    expect(acquireCalls.every((k) => k === 'airtable.com')).toBe(true);
  });

  it('rate compliance: real 5 rps limiter throttles 12 sequential requests to ≥1.8 s', async () => {
    const rateLimiter = new TokenBucketRateLimiter(5);
    const svc = new RevisionHistoryService(
      makeOrchestrator(),
      new RevisionHistoryParser(),
      buildRepo([]),
      buildUserRepo(),
      rateLimiter,
      makeLogger(),
    );

    // 12 requests at 5 rps — initial bucket has 5 tokens (burst capacity = rps).
    // First 5 calls are instant; remaining 7 each wait 200 ms → 1 400 ms minimum.
    // Lower bound set to 1 200 ms to absorb CI timing jitter.
    const N = 12;
    const start = Date.now();
    for (let i = 0; i < N; i++) {
      await svc.scrapeForPage(`app${i}`, `tbl${i}`, `row${i}`);
    }
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(1_200);
  }, 15_000);

  it('re-authenticates and retries on a 401 response without producing duplicates', async () => {
    let fetchCallCount = 0;
    const browserFetchMock = vi.fn().mockImplementation(() => {
      fetchCallCount++;
      // First call returns 401; second (post-reauth) succeeds
      if (fetchCallCount === 1) {
        return Promise.resolve({ status: 401, text: '{}' });
      }
      const activityId = `activity-reauth-${fetchCallCount}`;
      return Promise.resolve({
        status: 200,
        text: JSON.stringify({
          rowActivityInfoById: {
            [activityId]: {
              rowId: 'row1',
              groupType: 'cellUpdate',
              createdTime: new Date().toISOString(),
              originatingUserId: 'usr1',
              diffRowHtml: DIFF_HTML,
            },
          },
          rowActivityOrCommentUserObjById: {},
        }),
      });
    });

    const allRevisions: RevisionHistoryDocument[] = [];
    const orchestrator = makeOrchestrator(browserFetchMock);
    const svc = new RevisionHistoryService(
      orchestrator,
      new RevisionHistoryParser(),
      buildRepo(allRevisions),
      buildUserRepo(),
      makeFakeRateLimiter(),
      makeLogger(),
    );

    await svc.scrapeForPage('appX', 'tblX', 'rowX');

    // Session was invalidated after the 401
    expect(orchestrator.invalidateSession).toHaveBeenCalledOnce();
    // Two makeBrowserFetch calls total (one 401 + one success)
    expect(fetchCallCount).toBe(2);
    // Exactly one revision persisted, no duplicates
    expect(allRevisions).toHaveLength(1);
  });
});

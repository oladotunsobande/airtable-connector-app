# Airtable Connector — Implementation Plan

A full‑stack Airtable integration that (a) authenticates via OAuth and pulls
Bases → Tables → Records through the official REST API, and (b) runs a custom
Puppeteer‑driven scraper to harvest **Revision History** (Assignee & Status
changes) for every ticket, persisting everything to MongoDB and surfacing it in
an Angular + AG Grid UI.

---

## 1. Confirmed Decisions

These were agreed before planning and drive the architecture:

| Topic | Decision |
|---|---|
| **Official API auth** | OAuth 2.0 (authorization‑code + PKCE). Access + refresh tokens persisted in Mongo. The autonomous cron silently refreshes the access token when expired. |
| **Scraping model** | Puppeteer logs in (incl. MFA) and **harvests** live session cookies + per‑request tokens (`requestId`, `secretSocketId`) from the running Airtable web app. A `fetch`‑based service then **replays** the `readRowActivitiesAndComments` call at a rate‑limited pace. |
| **`/Users` endpoint** | **Ignored** — it is not a real Airtable API path. User objects returned inside revision‑history responses (`rowActivityOrCommentUserObjById`) are upserted into a `users` collection when not already present. |
| **DI** | Plain TypeScript classes with **manual constructor injection**. No DI library and no custom container — a single `composition-root.ts` wires the graph by hand with `new`. Classes depend on interfaces, never concrete types. |
| **Scraping lib** | `puppeteer`. **API calls** use native `fetch` (Node 22). **HTML parsing** uses `node-html-parser`. |
| **Deliverable for now** | This plan only. No code scaffolded yet. |

### Stack (per the task PDF)

- **Frontend:** Angular 19, AG Grid + AG Charts **33.0**, Angular Material + Material Icons.
- **Backend:** Node **v22**, TypeScript, native `fetch`, Puppeteer, `node-html-parser`, BullMQ (Redis), Mongoose (MongoDB).
- **Infra:** existing `docker-compose.yml` — Mongo 7 (`localhost:27017`, db `airtable_connector`, no auth) + Redis 7 (`localhost:6379`).

---

## 2. Monorepo Layout

A single repo with two apps and npm workspaces (no Nx — keeps it lightweight).

```
airtable-connector-app/
├── docker-compose.yml            # existing (mongo + redis)
├── package.json                  # root: workspaces + orchestration scripts
├── IMPLEMENTATION_PLAN.md
├── .env.example
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts               # bootstrap: builds app + starts it
│       ├── composition-root.ts   # the single manual-wiring point (new ...)
│       ├── config/               # env loading + typed config object
│       ├── core/
│       │   ├── logger/
│       │   └── errors/           # domain error hierarchy
│       ├── infrastructure/
│       │   ├── mongo/            # connection + Mongoose models
│       │   ├── queue/            # BullMQ queues, workers, scheduler
│       │   ├── http/             # fetch HttpClient adapter + retry
│       │   ├── rate-limit/       # per‑base token‑bucket limiter
│       │   └── browser/          # Puppeteer browser/session manager
│       ├── modules/
│       │   └── airtable/
│       │       ├── auth/         # OAuth service + token store/repo
│       │       ├── api/          # ApiClient + endpoint services (facade)
│       │       ├── scraping/     # session orchestrator, scraper, parser
│       │       ├── models/       # mongoose schemas + repositories
│       │       ├── pipeline/     # queue producers + worker processors
│       │       └── cron/         # scheduler registration
│       └── api/                  # HTTP server (controllers/routes/DTOs)
└── frontend/
    ├── package.json
    └── src/app/
        ├── core/                 # api services, models, interceptors
        ├── features/
        │   ├── data-grid/        # AG Grid view (Part C)
        │   ├── integrations/     # OAuth connect + status
        │   └── scraping/         # trigger + MFA modal
        └── shared/               # material components
```

---

## 3. Dependency Injection: Plain Classes + Manual Constructor Injection

**No DI library and no custom container.** Every service is a plain TypeScript
class that declares its collaborators as constructor parameters, typed against
**interfaces** (not concrete classes). A single **composition root**
(`composition-root.ts`) is the only place that picks concrete implementations
and wires the object graph by hand with `new`, in dependency order. `main.ts`
calls it and starts the wired application.

```ts
// A service depends on interfaces, never on concrete classes.
export class AirtableApiService implements IAirtableApiService {
  constructor(
    private readonly config: AppConfig,
    private readonly http: IHttpClient,
    private readonly tokens: ITokenProvider,
    private readonly rateLimiter: IRateLimiter,
  ) {}
  // ...
}

// composition-root.ts — the single wiring point.
export function buildApplication(): Application {
  const config = loadConfig();
  const log = logger.child('app');

  const httpClient   = new FetchHttpClient(log.child('http'));
  const rateLimiter  = new TokenBucketRateLimiter(config.airtable.rps);
  const tokenProvider = new TokenProvider(oauthService, tokenRepository);
  const apiService   = new AirtableApiService(config, httpClient, tokenProvider, rateLimiter);
  // ...construct the rest in order, then return what main.ts needs.
}
```

- **Why this over a container:** the graph is small and fully known at build
  time; explicit `new` calls are the simplest thing that works, are trivially
  type‑checked by `tsc`, need zero runtime machinery, and read top‑to‑bottom.
- **Per‑job state** in queue workers is passed as **method arguments**, not held
  in DI scopes — services stay stateless singletons constructed once.
- **Testing:** because constructors take interfaces, unit tests pass in fakes/
  stubs directly (`new AirtableApiService(cfg, fakeHttp, fakeTokens, fakeLimiter)`)
  with no framework.

**SOLID application throughout:**
- **S** — one responsibility per class (`OAuthService`, `RateLimiter`, `RevisionHistoryParser`, each repository, each worker processor).
- **O / L** — program to interfaces (`IHttpClient`, `ISessionProvider`, `IRepository<T>`); implementations are swappable at the composition root.
- **I** — narrow interfaces (a parser doesn't see HTTP; a repository doesn't see queues).
- **D** — every class depends on interfaces injected through its constructor; concrete types are named only in `composition-root.ts`.

---

## 4. Design Patterns (the "efficient scraping" architecture)

- **Queue‑based fan‑out pipeline (Producer/Consumer)** — the core scaling pattern. Work is split into staged BullMQ queues so each stage retries independently and respects rate limits:

  ```
  cron ──> [bases]  ──fanout──> [tables] ──fanout──> [revision-history]
            fetch tables          fetch records          scrape + parse
            per base              (paginated) per table   per row/ticket
  ```

- **Token‑bucket Rate Limiter** — enforces **5 req/s per base** for `api.airtable.com`; a separate, conservative bucket for the scraping host (`airtable.com`).
- **Repository pattern** — all Mongo access behind `IRepository<T>` interfaces.
- **Adapter pattern** — `HttpClient` wraps `fetch`; `BrowserSession` wraps Puppeteer.
- **Facade** — `AirtableApiService` exposes `getBases()/getTables()/getRecords()` over the raw client.
- **Strategy** — per‑column parsing strategies in the HTML parser (select/status vs collaborator/assignee vs text).
- **Factory** — DI factories build graphs; a `SessionFactory` mints authenticated sessions.

---

## 5. Data Model (MongoDB / Mongoose)

| Collection | Key fields | Notes |
|---|---|---|
| `oauthTokens` | `accessToken`, `refreshToken`, `scope`, `expiresAt`, `tokenType` | Single active record; refreshed by cron. Encrypted at rest (see §11). |
| `bases` | `airtableId`, `name`, `permissionLevel`, **`lastProcessedAt`**, **`processingStatus`** (`idle\|queued\|processing\|error`), **`processingErrors[]`**, `lastSuccessfulAt` | The cron's work unit. Flags requested in the brief. |
| `tables` | `airtableId`, `baseId`, `name`, `primaryFieldId`, `fields[]`, `lastProcessedAt` | Schema cached for dynamic grid columns. |
| `pages` | `airtableId` (recordId / rowId), `baseId`, `tableId`, `fields` (raw record JSON), `createdTime`, `revisionScrapedAt`, `revisionStatus` | "Tickets/Pages". `fields` stored as flexible object. |
| `revisionHistory` | `uuid`, `issueId`, `columnType`, `oldValue`, `newValue`, `createdDate`, `authoredBy` | Exact shape from the PDF screenshot. Upsert‑deduped on `uuid`. |
| `users` | `airtableId`, `email`, `name`, `profilePicUrl` | Upserted from `rowActivityOrCommentUserObjById`. |
| `scrapeSessions` | `cookies[]`, `harvestedTokens` (`secretSocketId`…), `state` (`active\|awaiting_mfa\|expired\|invalid`), `validatedAt`, `expiresAt` | Backs cookie validity + MFA flow. |

`revisionHistory` target object (verbatim from the brief):

```ts
{
  uuid: activityId,
  issueId: ticketId,            // rowId / pages.airtableId
  columnType: columnType,       // 'Status' | 'Assignee' (filtered)
  oldValue: oldValue,
  newValue: newValue,
  createdDate: new Date(activityData.createdTime),
  authoredBy: activityData.originatingUserId,
}
```

---

## 6. Phased Development

### Phase 0 — Scaffolding & tooling
- Root `package.json` with npm workspaces; scripts: `dev`, `build`, `lint`, `test`, `docker:up`.
- Backend TS project (Node 22, ESM, strict). Frontend via `ng new` (Angular 19, Material).
- `.env.example` (Mongo URI, Redis URL, OAuth client id/secret/redirect, Airtable login email/password, encryption key, `MAX_BASES_PER_RUN=5`, `AIRTABLE_RPS=5`).
- **Exit:** `docker compose up` healthy; both apps build & boot empty.

### Phase 1 — Core infrastructure
- `composition-root.ts` skeleton (§3) — the manual-wiring entry point.
- Typed config loader, structured logger, domain error hierarchy.
- Mongo connection (Mongoose) + graceful shutdown.
- BullMQ connection (queues + worker bootstrap helpers).
- `HttpClient` over `fetch` (timeout, JSON, typed errors, retry/backoff on 429/5xx honoring `Retry-After`).
- **Per‑base token‑bucket `RateLimiter`** (`acquire(baseId)` → resolves when a token is free; refill 5/s).
- **Exit:** composition root builds the graph and the app boots; limiter unit‑tested to cap at 5/s.

### Phase 2 — Models & repositories
- All Mongoose schemas (§5) + `IRepository<T>` interfaces and implementations.
- Indexes: `bases.airtableId` unique; `pages.airtableId` unique; `revisionHistory.uuid` unique; `pages` compound `{baseId, tableId}`.
- **Exit:** CRUD + upsert covered by integration tests against the docker Mongo.

### Phase 3 — OAuth authentication
- `OAuthService`: build authorize URL (PKCE), exchange code→tokens, **refresh** flow, persist via `TokenRepository`.
- A `TokenProvider` that returns a valid access token, refreshing on demand (used by the API client and the cron).
- HTTP routes: `GET /auth/airtable/start`, `GET /auth/airtable/callback`, `GET /auth/status`.
- **Exit:** end‑to‑end OAuth against a real Airtable account; token auto‑refresh verified by forcing expiry.

### Phase 4 — Airtable REST API client
- `AirtableApiService` (facade) on `HttpClient` + `TokenProvider`, every call gated by `RateLimiter`:
  - `getBases()` → `/meta/bases` (paginated via `offset`).
  - `getTables(baseId)` → `/meta/bases/${baseId}/tables`.
  - `getRecords(baseId, tableId)` → `/${baseId}/${tableId}` **with full `offset` pagination** (the brief's "Important: use Airtable API Pagination").
- Persist bases/tables/pages through repositories (upsert by Airtable id).
- **Exit:** a base's tables + all records (multi‑page) land in Mongo with correct pagination.

### Phase 5 — Queue pipeline + cron scheduler
- Queues: `bases`, `tables`, `revision-history`; one worker per queue with tuned concurrency; all share the `RateLimiter`.
- **Producers:** cron → `bases`; `bases` worker → fan‑out `tables`; `tables` worker → paginate records then fan‑out `revision-history` per row.
- **Cron** (registered at startup; runs every 5 min):
  1. Pull up to `MAX_BASES_PER_RUN` (default 5, env‑configurable) bases, prioritising `processingStatus != processing` ordered by oldest `lastProcessedAt`.
  2. If **no bases exist**, call `getBases()` and store them first.
  3. Enqueue each selected base on the `bases` queue; mark `processingStatus='queued'`.
  - Implemented as a **BullMQ repeatable job** (idempotent add at boot) so schedule survives restarts and is itself rate‑aware.
- Workers update base flags: `processing` → on success set `lastProcessedAt`/`lastSuccessfulAt`, clear errors; on failure push to `processingErrors[]` and set `error`.
- Retries with backoff; dead‑letter handling for poison jobs.
- **Exit:** booting the backend with an empty DB auto‑fetches bases and drives the full pipeline; rate stays ≤5 req/s/base (observed in logs).

### Phase 6 — Puppeteer session, cookies & MFA
- `BrowserManager` (launch/reuse a browser) + `SessionOrchestrator` that owns the login lifecycle and persists to `scrapeSessions`.
- **Login + harvest:** navigate to Airtable login, submit email/password from env; **intercept** a `readRowActivitiesAndComments` request (via `page.on('request')`) plus `page.cookies()` to capture cookies + `requestId`/`secretSocketId`.
- **MFA from frontend:** when an MFA challenge is detected, set session `state='awaiting_mfa'` and keep the page alive in an in‑memory map keyed by `sessionId`; expose `POST /scraping/mfa { sessionId, code }` which feeds the code to the waiting page and resolves a pending promise to finish login. *(Assumes single backend instance; documented as a constraint.)*
- **Validity check:** `isSessionValid()` issues a cheap `readRowActivitiesAndComments` probe; 401/403/expired ⇒ mark `expired` and trigger re‑login.
- **Exit:** a session is established with MFA supplied from the UI; cookies validate; expiry is detected and re‑acquired.

### Phase 7 — Revision history scraper + parser
- `RevisionHistoryService` (fetch‑based replay): builds the `stringifiedObjectParams` (`{limit, offsetV2, shouldReturnDeserializedActivityItems:true, shouldIncludeRowActivityOrCommentUserObjById:true}`), attaches harvested cookies/tokens, **paginates via `offsetV2`**, retries through `SessionOrchestrator` if cookies expire mid‑run.
- `RevisionHistoryParser` (`node-html-parser`): for each `rowActivityInfoById` entry with `groupType='cellUpdate'`, parse `diffRowHtml` to extract column name (from `.micro.strong.caps[columnId]`) and old/new pill values; **keep only `Status` and `Assignee` changes**. Map into the §5 target object. Per‑column **Strategy** classes handle select/status pills vs collaborator/assignee tokens.
- Upsert `users` from `rowActivityOrCommentUserObjById`; dedupe `revisionHistory` by `uuid`.
- **Exit:** revision history for ≥200 pages is scraped, parsed, deduped, and stored; Assignee/Status transitions verified against the Airtable UI on spot checks.

### Phase 8 — Backend REST API for the frontend (Part C)
- `GET /integrations` → `[{ id:'airtable', name:'Airtable', connected }]`.
- `GET /entities` → list of Mongo collection names (`bases`, `tables`, `pages`, `revisionHistory`, `users`).
- `GET /entities/:name/data` → paginated rows + inferred field set, supporting server‑side `search`, `sort`, and `filter` query params (so large collections don't ship wholesale).
- `POST /scraping/start` (kick off session) + `POST /scraping/mfa` (Phase 6).
- DTOs + validation; CORS for the Angular dev server.
- **Exit:** every endpoint returns shaped JSON; manual + integration tests green.

### Phase 9 — Angular frontend (Part C)
- Angular Material shell (toolbar, side nav, theming, Material Icons).
- **Active Integrations** dropdown (Airtable) + **Entity** dropdown bound to `/entities`.
- **AG Grid 33** view: **dynamic column defs inferred from the selected collection's documents**; quick‑filter **search** box; **sortable + filterable** on all columns; server‑side pagination wired to `/entities/:name/data`.
- **AG Charts 33**: a small summary (e.g. Status changes over time / per assignee) off `revisionHistory`.
- **Scraping panel**: "Connect (OAuth)", "Start scrape", and an **MFA code modal** posting to `/scraping/mfa`.
- **Exit:** clean, responsive UI; switching entities reshapes the grid dynamically; search/sort/filter work.

### Phase 10 — Testing, hardening & docs
- Unit tests (rate limiter, parser strategies, DI container, OAuth refresh).
- Integration tests (repos, pipeline) against docker Mongo/Redis.
- **Load test the brief's requirement: ≥200 pages** end‑to‑end; assert rate compliance and zero duplicate revisions.
- `README.md`: setup, env, OAuth registration steps, run instructions, architecture overview.
- **Exit:** documented, reproducible, all tests pass.

---

## 7. Rate‑Limit Strategy (≤5 req/s per base)

- A `RateLimiter.acquire(baseId)` token bucket (capacity 5, refill 5/token‑sec) wraps **every** `api.airtable.com` call inside the API client — so it holds across all queues automatically.
- BullMQ worker **concurrency** is tuned alongside the bucket; the bucket is the source of truth, concurrency just prevents idle waste.
- `HttpClient` still honours `429` + `Retry-After` as a safety net.
- A separate, conservative bucket guards the scraping host (`airtable.com`), which is undocumented.

## 8. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `secretSocketId` tied to a live socket and expiring mid‑scrape | Validity probe + re‑harvest via `SessionOrchestrator`; jobs retry on the refreshed session. |
| Airtable changes login/MFA DOM | Isolate all selectors in `BrowserManager`; fail loud with clear errors. |
| MFA coordination requires a live in‑memory page | Documented single‑instance constraint for the scraper; OAuth/API path is stateless and scales freely. |
| HTML diff format variance across column types | Strategy‑per‑column parsing + golden‑file tests on captured fixtures. |
| Scraping Airtable's private endpoints (ToS / brittleness) | Implemented strictly for this evaluation against the owner's own account; kept conservative and rate‑limited. |

## 9. Open Assumptions

- One Airtable account; its login credentials live in env, MFA code comes from the UI at runtime.
- `MAX_BASES_PER_RUN` defaults to 5 and is env‑configurable, as requested.
- Single backend instance for the scraper (MFA/session state is in‑memory); the OAuth/API ingestion is horizontally scalable.

---

*Next step on approval: Phase 0 + Phase 1 (scaffold the monorepo and stand up the DI container, config, Mongo/Redis, HTTP client, and rate limiter).*

# Airtable Connector

A full-stack application that authenticates with the Airtable OAuth 2.0 API, scrapes revision history from Airtable bases via Puppeteer, and exposes the data through a REST API consumed by an Angular 19 frontend with AG Grid.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [OAuth App Registration](#oauth-app-registration)
4. [Environment Variables](#environment-variables)
5. [Setup](#setup)
6. [Running the Application](#running-the-application)
7. [Running Tests](#running-tests)
8. [API Reference](#api-reference)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Angular 19 Frontend  (localhost:4200)                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Integrations│  │ Data Grid    │  │ Scraping Control      │  │
│  │ (OAuth flow)│  │ AG Grid 33   │  │ + MFA Dialog          │  │
│  └─────────────┘  └──────────────┘  └───────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP  (localhost:3000)
┌────────────────────────────▼────────────────────────────────────┐
│  Express REST API                                               │
│  GET /integrations   GET /entities   GET /entities/:name/data   │
│  GET/POST/DELETE /auth/airtable/*    POST /scraping/start       │
└───┬──────────────┬───────────────────────────┬──────────────────┘
    │              │                           │
    │ Mongoose     │ BullMQ                    │ Puppeteer
    ▼              ▼                           ▼
 MongoDB        Redis                  Airtable Web UI
 (port 27017)   (port 6379)           (browser session)
    ▲
    │ fetch (rate-limited 5 rps)
    ▼
 Airtable Internal API
 /v0.3/{baseId}/{tableId}/readRowActivitiesAndComments
```

### Key Design Decisions

| Concern | Approach |
|---|---|
| Auth | OAuth 2.0 PKCE flow; tokens stored in MongoDB, auto-refreshed 60 s before expiry |
| Session | Puppeteer logs into Airtable web UI; harvested cookies/socket token reused for API calls |
| Rate limiting | Token-bucket limiter, one bucket per host key, configurable rps (default 5) |
| Ingestion | BullMQ pipeline: bases → tables → pages → revision history, each stage a separate queue/worker |
| Deduplication | Revision history upsertion keyed on `uuid = activityId`; Mongoose `unique` index enforces it |
| DI | Manual composition root (`composition-root.ts`); no IoC container, plain constructors |
| Pagination | Airtable `offsetV2` cursor pagination; all pages fetched and persisted before returning |

---

## Prerequisites

- **Node.js** ≥ 20
- **npm** ≥ 10
- **Docker** (for MongoDB and Redis, or run them manually)
- An **Airtable account** with an OAuth application (see below)

---

## OAuth App Registration

1. Go to [https://airtable.com/create/oauth](https://airtable.com/create/oauth) and sign in.
2. Click **Register an OAuth integration**.
3. Fill in the form:
   - **Name**: any descriptive name (e.g. `Airtable Connector Dev`)
   - **Homepage URL**: `http://localhost:3000`
   - **OAuth redirect URL**: `http://localhost:3000/auth/airtable/callback`
4. Under **Scopes**, enable:
   - `data.records:read`
   - `schema.bases:read`
5. Click **Register integration**.
6. Copy the **Client ID** and **Client Secret** — you will need these in `.env`.

---

## Environment Variables

Create `backend/.env` (copy from the template below):

```dotenv
# ── Server ──────────────────────────────────────────────────────
NODE_ENV=development
PORT=3000

# ── MongoDB ─────────────────────────────────────────────────────
MONGO_URI=mongodb://localhost:27017/airtable_connector

# ── Redis ───────────────────────────────────────────────────────
REDIS_HOST=localhost
REDIS_PORT=6379

# ── Airtable OAuth ──────────────────────────────────────────────
AIRTABLE_CLIENT_ID=your_client_id_here
AIRTABLE_CLIENT_SECRET=your_client_secret_here
AIRTABLE_REDIRECT_URI=http://localhost:3000/auth/airtable/callback
AIRTABLE_SCOPES=data.records:read schema.bases:read

# ── Airtable Login (Puppeteer session) ──────────────────────────
AIRTABLE_LOGIN_EMAIL=your_airtable_email@example.com
AIRTABLE_LOGIN_PASSWORD=your_airtable_password

# ── Rate limiting ───────────────────────────────────────────────
# Max requests per second to airtable.com (default: 5)
AIRTABLE_RPS=5

# ── Security ────────────────────────────────────────────────────
# 32-byte hex key for encrypting sensitive data at rest
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=your_32_byte_hex_key_here

# ── Pipeline ────────────────────────────────────────────────────
# Max bases to process per cron run (default: 5)
MAX_BASES_PER_RUN=5
```

> In `development` mode, missing required variables are replaced with `__MISSING_<KEY>__` placeholders so the server boots without all secrets configured. Production (`NODE_ENV=production`) fails fast on any missing variable.

---

## Setup

```bash
# 1. Clone and install all workspaces
git clone <repo-url>
cd airtable-connector-app
npm install

# 2. Start MongoDB and Redis via Docker
npm run docker:up

# 3. Create backend/.env (see above)
cp backend/.env.example backend/.env
# then edit backend/.env with your credentials
```

---

## Running the Application

### Development (hot-reload)

```bash
# Starts both backend (tsx watch) and frontend (ng serve) concurrently
npm run dev
```

- Backend: [http://localhost:3000](http://localhost:3000)
- Frontend: [http://localhost:4200](http://localhost:4200)

### Run individually

```bash
# Backend only
npm run dev -w backend

# Frontend only
npm run dev -w frontend
```

### Production build

```bash
npm run build
npm run start -w backend   # serves compiled JS
```

### OAuth Flow

1. Open [http://localhost:4200/integrations](http://localhost:4200/integrations).
2. Click **Connect Airtable** — you will be redirected to Airtable's authorization page.
3. Approve the requested scopes.
4. Airtable redirects back to `http://localhost:3000/auth/airtable/callback`; tokens are stored in MongoDB.
5. The integrations page shows **Connected**.

### Scraping

1. Open [http://localhost:4200/scraping](http://localhost:4200/scraping).
2. Click **Start Scraping Session** — the backend launches Puppeteer, logs in to Airtable, and harvests session cookies.
3. If Airtable requires MFA, a dialog appears — enter your code and submit.
4. Once the session is active, a scheduled cron job (configurable interval) enqueues base → table → page → revision-history jobs via BullMQ.

---

## Running Tests

```bash
# All tests (backend + frontend)
npm test

# Backend only (93 tests)
npm test -w backend

# Backend with watch mode
npm run test:watch -w backend   # or: cd backend && npx vitest
```

### Test Coverage

| Suite | Tests | What it covers |
|---|---|---|
| `oauth.service.test.ts` | 12 | PKCE URL generation, code exchange, token refresh, error wrapping |
| `token-provider.test.ts` | 8 | Auto-refresh at 60-s buffer, no-token error, isConnected |
| `airtable-api.service.test.ts` | 13 | Rate-limited API calls, retry logic |
| `revision-history.parser.test.ts` | 11 | Status/Assignee column strategies, HTML diff parsing |
| `revision-history.service.load.test.ts` | 4 | 200-page throughput, zero duplicates, rate compliance, 401 re-auth |
| `repositories.integration.test.ts` | 27 | All 5 Mongoose repositories against real MongoDB |
| `token-bucket-rate-limiter.test.ts` | 5 | Burst capacity, sustained rps, backpressure |
| `api.routes.test.ts` | 13 | REST API endpoints: integrations, entities, pagination/sort/filter |

---

## API Reference

### Auth

| Method | Path | Description |
|---|---|---|
| `GET` | `/auth/airtable/start` | Redirects to Airtable OAuth authorization page |
| `GET` | `/auth/airtable/callback` | Handles OAuth callback; stores tokens; redirects to frontend |
| `DELETE` | `/auth/airtable/disconnect` | Deletes stored tokens |

### Integrations

| Method | Path | Description |
|---|---|---|
| `GET` | `/integrations` | Returns list of integrations and their connection state |

### Entities

| Method | Path | Query params | Description |
|---|---|---|---|
| `GET` | `/entities` | — | Lists all entity types with document counts |
| `GET` | `/entities/:name/data` | `page`, `pageSize` (max 200), `search`, `sortField`, `sortDir`, `filterField`, `filterOp`, `filterValue` | Paginated, searchable, sortable entity data |

Valid entity names: `bases`, `tables`, `pages`, `revisionHistory`, `users`

Valid `filterOp` values: `eq`, `contains`, `gt`, `lt`

### Scraping

| Method | Path | Description |
|---|---|---|
| `POST` | `/scraping/start` | Starts a Puppeteer login session |
| `POST` | `/scraping/mfa` | Submits an MFA code to a pending session |
| `GET` | `/scraping/session` | Returns current session state |

# Single-Page Manual Scraping Dashboard — Implementation Plan

## Goal

Collapse the three current pages (**Integrations**, **Scraping**, **Data Grid**)
into a **single dashboard page**, remove the background scheduled (cron) job, and
make scraping a **manual, button-triggered** operation whose **logs stream live**
to the page. On a fatal failure the page shows the error message in place of the
data grid; otherwise it shows the grid.

### Layout

```
┌─────────────────────────────┬─────────────────────────────┐
│  Integrations (top-left)    │  Scraping control + logs    │
│  - connect / disconnect     │  - "Start Scraping" button  │
│  - connection status        │  - status chip              │
│                             │  - live log panel (SSE)     │
├─────────────────────────────┴─────────────────────────────┤
│  Data Grid (full width, below)                            │
│  …OR… Error panel, when the run failed fatally            │
└───────────────────────────────────────────────────────────┘
```

## Decisions (confirmed)

| Topic | Decision |
|-------|----------|
| Log delivery | **SSE live stream** — backend exposes a Server-Sent Events endpoint; page subscribes; stream closes when the run ends. |
| Execution model | **Keep BullMQ, trigger on-demand** — remove only the 5-min repeatable scheduler; keep queues + workers; the button enqueues the bootstrap job. |
| Failure → error display | **Only on fatal run failure** — login/session failure or a `bases`/`tables` ingest error. Individual revision-history row failures are logged but still show the grid. |
| Queue hygiene | **Clear the queues at the start of every run** (`obliterate`) so no stale jobs accumulate. |

---

## Backend Changes

### 1. Remove the scheduled job

**`src/modules/airtable/cron/cron-scheduler.ts`**
- Delete `scheduleRepeatingJob()` and the `upsertJobScheduler('pipeline-tick', { every: … })` call.
- Keep `registerWorkers()` — workers must still be running to process on-demand jobs.
- Rename the class to **`PipelineWorkers`** (responsibility is now "register workers", not "schedule"). Update the `cron-scheduler.interface.ts` accordingly, or fold worker registration into the new run service (below).

**`src/main.ts`**
- Replace `await app.cronScheduler.start()` with `app.pipelineWorkers.registerWorkers()` (no repeatable job is scheduled).
- Remove the stale `TODO (Phase 6+)` comment.

**`src/composition-root.ts`**
- Rename `cronScheduler` → `pipelineWorkers`; wire the new `ScrapeRunService` (below).

### 2. New `ScrapeRunService` — run lifecycle + orchestration

New file: **`src/modules/airtable/pipeline/scrape-run.service.ts`** (+ interface).

Holds a single in-memory **current run**:

```ts
type RunStatus = 'idle' | 'logging_in' | 'awaiting_mfa' | 'running' | 'completed' | 'failed';

interface ScrapeRun {
  runId: string;
  status: RunStatus;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}
```

Responsibilities:

1. **Guard** — reject a new run while one is `logging_in` / `awaiting_mfa` / `running` (HTTP 409), so queue clearing never races a live run.
2. **Ensure session** — call `sessionOrchestrator.startLogin()`.
   - `awaiting_mfa` → set status `awaiting_mfa`, return to caller (frontend shows MFA dialog).
   - `active` → continue.
3. **Clear the queues** — `obliterate({ force: true })` on `cron`, `bases`, `tables`,
   `revision-history` queues to drop any stale waiting/active/completed/failed jobs.
4. **Reset MongoDB processing state** so the pipeline re-runs end-to-end:
   - Bases → `processingStatus = 'pending'` (makes them eligible for `findForProcessing`).
   - Pages → `revisionStatus = 'pending'` (forces re-scrape of revision history).
   *(Add `resetAllStatuses()` helpers to the base + page repositories.)*
5. **Kick off the pipeline** — enqueue one bootstrap job on the `cron` queue
   (re-uses the existing `cron.processor`, which ingests bases if empty and enqueues them).
6. **Watch for completion** (see §4) and emit a terminal SSE event.

### 3. Live log capture → SSE

**`src/core/logger/index.ts`**
- Add a lightweight listener registry so logs can be teed without changing call sites:
  ```ts
  type LogListener = (entry: LogEntry) => void;
  const listeners = new Set<LogListener>();
  export function addLogListener(fn: LogListener): void { listeners.add(fn); }
  export function removeLogListener(fn: LogListener): void { listeners.delete(fn); }
  ```
  In `log()`, after writing to the stream, call each listener with the entry.
  (Stream output is unchanged — terminal logging still works.)

**`ScrapeRunService`** registers a listener for the duration of a run, filters to
pipeline-relevant contexts (`cron-processor`, `bases-processor`, `tables-processor`,
`revision-history-processor`, `session`, `revision`, `ingest`), keeps a bounded
in-memory buffer (e.g. last 1000 lines for reconnects), and pushes each line to all
connected SSE clients. Listener is removed when the run reaches `completed`/`failed`.

### 4. Completion + fatal-failure detection

- **Completion**: after the bootstrap is enqueued, poll `getJobCounts()` across
  `cron` + `bases` + `tables` + `revision-history` every ~2s. When all report
  `waiting + active + delayed + prioritized === 0` (after at least one non-trivial
  tick, to avoid the momentary zero right after enqueue), set status `completed`.
- **Fatal failure**: attach BullMQ `QueueEvents('failed')` listeners on the
  **`bases`** and **`tables`** queues only. First failure → status `failed`, capture
  `failedReason` as `error`, stop the run.
  - `revision-history` failures are **not** fatal — they are logged (already handled
    in `revision-history.processor.ts`) and still stream to the page.
- Either terminal transition emits an SSE `status` event and closes streams.

### 5. New / changed HTTP endpoints (`src/api/http-server.ts`)

| Method & path | Purpose |
|---|---|
| `POST /scraping/run` | Start (or continue after MFA) a manual run. Returns `{ runId, status }`. `status` may be `awaiting_mfa`, `running`, or `409` if already active. |
| `GET  /scraping/run` | Current run snapshot `{ runId, status, error, startedAt, finishedAt }` (for page load / reconnect). |
| `GET  /scraping/run/stream` | **SSE**. Emits buffered + live log events, then one terminal status event. |
| `POST /scraping/mfa` | Unchanged — feeds the TOTP code; on success the caller re-POSTs `/scraping/run`. |

- **Remove** `POST /scraping/start` (superseded by `/scraping/run`).
- **Keep** `GET /scraping/session` (optional; can be dropped if unused by the new UI).
- SSE handler sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`, flushes headers, registers the response with the run
  service, and cleans up on `req.on('close')`. CORS already allows `localhost:4200`;
  ensure the SSE response carries the same `Access-Control-Allow-Origin` header.

**SSE event format**

```
event: log
data: {"level":"info","context":"bases-processor","message":"Processing base","ts":"…"}

event: status
data: {"status":"completed","error":null}
```

### 6. Repository additions

- `IBaseRepository.resetAllForReprocessing()` → set every base `processingStatus='pending'`, clear `lastError`.
- `IPageRepository.resetAllRevisionStatus()` → set every page `revisionStatus='pending'`.
- (Mongo implementations: simple `updateMany({}, { $set: … })`.)

---

## Frontend Changes

### 1. Single dashboard route

**`src/app/app.routes.ts`**
- Collapse to one route: `''` → new `DashboardComponent`; wildcard redirects to `''`.
- Drop `data-grid`, `integrations`, `scraping` routes.

**`src/app/app.component.html`**
- Remove the toolbar nav buttons (`routerLink` to integrations/scraping). Keep the
  title bar. Drop unused `RouterLink` import from `app.component.ts`.

### 2. New `DashboardComponent`

New: `src/app/features/dashboard/dashboard.component.{ts,html,scss}`.
- CSS-grid layout: row 1 = `<app-integrations>` (left) + `<app-scraping>` (right);
  row 2 = grid-or-error.
- Reads a shared **`ScrapeRunStore`** (signals) to decide row 2:
  ```html
  @if (store.status() === 'failed') {
    <error-panel [message]="store.error()" />
  } @else {
    <app-data-grid />
  }
  ```

### 3. `ScrapeRunStore` (frontend signal service)

New: `src/app/core/scrape-run/scrape-run.store.ts` — `@Injectable({providedIn:'root'})`.
- Signals: `status`, `error`, `logs: string[]`, `completedAt`.
- `start()` → `POST /scraping/run`; on `awaiting_mfa` open MFA dialog, on `running`
  open the SSE stream.
- `openStream()` → `new EventSource(\`${API_BASE}/scraping/run/stream\`)`; append `log`
  events to `logs`; on `status` event set `status`/`error`, bump `completedAt`, close.
- Single source of truth shared by Scraping + Dashboard + DataGrid.

### 4. Rework `ScrapingComponent`

- Replace the session-state card with: **Start Scraping** button, a status chip
  (`idle / logging in / awaiting MFA / running / completed / failed`), and a
  **scrollable log panel** bound to `store.logs()` (auto-scroll to bottom).
- Button calls `store.start()`; disabled while `logging_in`/`running`.
- Keep the existing **MFA dialog**; after submit, call `store.start()` again to
  continue into the run.

### 5. `DataGridComponent`

- Largely unchanged; embedded below. Add an `effect` on `store.completedAt()` to
  re-fetch the datasource when a run completes, so new data appears automatically.

### 6. `ApiService`

- Add `startRun()` (`POST /scraping/run`) and `getRunStatus()` (`GET /scraping/run`).
- SSE uses `EventSource` directly (not `HttpClient`).
- Remove `startScraping()`/`getScrapingSession()` once unused. Keep `submitMfa()`.
- Update `api.models.ts`: add `RunStatus`, `RunSnapshot`; remove obsolete
  `ScrapingSession`/`StartSessionResponse` if no longer referenced.

---

## Run Lifecycle (state machine)

```
idle ──POST /run──▶ logging_in ──(MFA needed)──▶ awaiting_mfa ──MFA ok / re-POST──▶ running
  │                     │                                                              │
  │                     └────────(session active)───────────────────────────────────▶ │
  │                                                                                    ▼
  │                                              ┌───────── all queues idle ──────▶ completed
  └──────────────────────────────────────────── │
                                                 └── bases/tables job failed ────▶ failed
```

- `completed` → dashboard shows data grid (auto-refreshed).
- `failed` → dashboard shows error panel instead of the grid.
- Fresh `POST /scraping/run` from a terminal state starts a new run (clears queues first).

---

## Implementation Order

1. **Backend – logger listener** (§3) — additive, no behavior change.
2. **Backend – repository reset helpers** (§6).
3. **Backend – `ScrapeRunService`** (§2, §4) incl. queue obliterate + completion watcher.
4. **Backend – remove scheduler, rename to `PipelineWorkers`** (§1); update `main.ts` + composition root.
5. **Backend – HTTP endpoints + SSE** (§5).
6. **Frontend – `ScrapeRunStore` + `ApiService`** (§3, §6).
7. **Frontend – `DashboardComponent` + routes/toolbar** (§1, §2).
8. **Frontend – rework `ScrapingComponent` (log panel)** (§4) and `DataGrid` refresh (§5).
9. **End-to-end verify** (below).

---

## Verification (runtime)

1. Start backend + frontend; open the single dashboard page.
2. Click **Start Scraping** with a disconnected/again with connected Airtable account.
3. Confirm log lines stream live into the panel (bases → tables → revision-history).
4. Confirm the data grid below populates and auto-refreshes when the run completes.
5. Force a fatal failure (e.g. invalid Airtable credentials) → confirm the **error
   message replaces the grid** and the run ends as `failed`.
6. Confirm **no repeatable job** is registered (Redis has no `pipeline-tick` scheduler;
   queues are empty/obliterated at the next run start).
7. Re-run twice back-to-back → confirm queues are cleared each time (no duplicate jobs).

---

## Out of Scope / Notes

- Multi-user concurrency: a single global run is assumed (matches current single-server design).
- Persisting run history/logs to MongoDB is not required (in-memory buffer + SSE only).
- The earlier debug logging + `/tmp` screenshots in `session-orchestrator.ts` can be
  trimmed during step 8 cleanup, but are not required by this change.
```

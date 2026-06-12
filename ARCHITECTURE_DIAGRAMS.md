# Scraping Dashboard — Sequence & Data Flow Diagrams

---

## 1. Run Lifecycle — Sequence Diagram

Shows every actor interaction from the moment the user clicks **Start Scraping** through to the grid refresh, including the MFA branch.

```mermaid
sequenceDiagram
    actor User
    participant SC  as ScrapingComponent<br/>(Angular)
    participant St  as ScrapeRunStore<br/>(signal service)
    participant API as Backend HTTP<br/>/scraping/*
    participant SRS as ScrapeRunService
    participant SO  as SessionOrchestrator<br/>(Puppeteer)
    participant Q   as BullMQ Queues<br/>(cron / bases / tables / rev-hist)
    participant W   as Pipeline Workers
    participant MDB as MongoDB
    participant DC  as DataGridComponent

    User->>SC: click "Start Scraping"
    SC->>St: start()
    St->>API: POST /scraping/run
    API->>SRS: start()

    alt No active session
        SRS->>SO: startLogin()
        SO-->>SRS: { state: "awaiting_mfa", sessionId }
        SRS-->>API: { status: "awaiting_mfa", sessionId }
        API-->>St: 200 { status: "awaiting_mfa", sessionId }
        St->>St: status ← "awaiting_mfa"<br/>sessionId ← id

        SC->>SC: effect fires → openMfaDialog()
        User->>SC: enters TOTP code
        SC->>API: POST /scraping/mfa { sessionId, code }
        API->>SO: submitMfaCode(sessionId, code)
        SO-->>API: 204
        API-->>SC: 204
        SC->>St: start()  ← re-POST after MFA
        St->>API: POST /scraping/run
        API->>SRS: start()  ← continueAfterMfa()
        SRS->>SO: getSessionState()
        SO-->>SRS: { state: "active" }
    else Session already active
        SRS->>SO: startLogin()
        SO-->>SRS: { state: "active" }
    end

    SRS->>Q: obliterate all queues
    SRS->>MDB: resetAllForReprocessing() — bases → idle
    SRS->>MDB: resetAllRevisionStatus()  — pages → pending
    SRS->>Q: add "pipeline-tick" to cron queue
    SRS->>SRS: startCompletionWatcher (poll every 2 s)
    SRS->>SRS: startFailureWatchers (QueueEvents on bases + tables)
    SRS-->>API: { runId, status: "running" }
    API-->>St: 200 { status: "running" }
    St->>St: status ← "running"
    St->>St: openStream() → EventSource /scraping/run/stream

    Note over SRS,St: SSE connection open

    loop Pipeline execution
        Q->>W: cron-processor tick
        W->>MDB: ingestBases() if empty
        W->>Q: enqueue bases jobs
        Q->>W: bases-processor
        W->>MDB: ingestTables(), update base status
        W->>Q: enqueue tables + revision-history jobs
        Q->>W: tables-processor
        W->>MDB: ingestRecords(), update table status
        Q->>W: revision-history-processor
        W->>SO: scrape revision history (Puppeteer)
        W->>MDB: save RevisionHistory docs
        W-->>SRS: log events via LogListener
        SRS-->>St: SSE event: { event:"log", data:{...} }
        St->>St: logs.update([...line])
        SC->>SC: log panel auto-scrolls
    end

    alt All queues idle (completion)
        SRS->>SRS: completionWatcher detects total=0
        SRS-->>St: SSE event: { event:"status", data:{ status:"completed" } }
        St->>St: status ← "completed"<br/>completedAt ← now
        St->>St: closeStream()
        DC->>DC: effect(completedAt) → refreshDatasource()
        DC->>API: GET /entities/revisionHistory/data
        API-->>DC: paginated rows
        DC->>User: grid refreshed ✓
    else Fatal failure on bases or tables queue
        SRS->>SRS: QueueEvents "failed" fires
        SRS-->>St: SSE event: { event:"status", data:{ status:"failed", error:"…" } }
        St->>St: status ← "failed"<br/>error ← message
        St->>St: closeStream()
        SC->>User: DashboardComponent shows error panel instead of grid
    end
```

---

## 2. System Data Flow Diagram

Shows the steady-state data paths: how a manual trigger moves through every layer, and how results surface back to the user.

```mermaid
flowchart TD
    subgraph Browser["Browser (Angular)"]
        BTN["Start Scraping button"]
        SStore["ScrapeRunStore\n(signals: status, logs, completedAt)"]
        SCOMP["ScrapingComponent\n(status chip + log panel)"]
        DCOMP["DataGridComponent\n(AG Grid + chart)"]
        DASH["DashboardComponent\n(grid layout)"]
        INTS["IntegrationsComponent\n(OAuth connect/disconnect)"]
        ES["EventSource\n/scraping/run/stream"]
    end

    subgraph Backend["Backend (Express / Node.js)"]
        HTTP["HTTP Server\n:3000"]
        SRS["ScrapeRunService\n(run state + SSE registry)"]
        LOG["Logger\n(addLogListener / broadcast)"]
        SO["SessionOrchestrator\n(Puppeteer)"]
    end

    subgraph Queue["BullMQ (Redis)"]
        CQ["cron queue"]
        BQ["bases queue"]
        TQ["tables queue"]
        RQ["revision-history queue"]
    end

    subgraph Workers["BullMQ Workers (in-process)"]
        CW["cron-processor\n(bootstrap)"]
        BW["bases-processor\n(ingest tables)"]
        TW["tables-processor\n(ingest records)"]
        RW["revision-history-processor\n(scrape + parse)"]
    end

    subgraph Mongo["MongoDB"]
        BASES["bases collection"]
        TABLES["tables collection"]
        PAGES["pages collection"]
        REVH["revisionHistory collection"]
        SESS["scrapeSessions collection"]
        TOKENS["tokens collection"]
    end

    subgraph Airtable["Airtable"]
        OAPI["OAuth / REST API"]
        WEB["Web UI (Puppeteer target)"]
    end

    %% ── Trigger ──────────────────────────────────────────────────────────────
    BTN -->|"store.start()"| SStore
    SStore -->|"POST /scraping/run"| HTTP
    HTTP --> SRS

    %% ── Login / MFA ──────────────────────────────────────────────────────────
    SRS -->|"startLogin()"| SO
    SO -->|"headless login"| WEB
    SO -->|"session cookies"| SESS
    SCOMP -->|"POST /scraping/mfa"| HTTP
    HTTP -->|"submitMfaCode()"| SO

    %% ── Queue bootstrap ──────────────────────────────────────────────────────
    SRS -->|"obliterate + reset"| Queue
    SRS -->|"resetAllForReprocessing()"| BASES
    SRS -->|"resetAllRevisionStatus()"| PAGES
    SRS -->|"add pipeline-tick"| CQ

    %% ── Worker pipeline ──────────────────────────────────────────────────────
    CQ --> CW
    CW -->|"ingestBases()"| OAPI
    CW -->|"upsert"| BASES
    CW -->|"enqueue base jobs"| BQ

    BQ --> BW
    BW -->|"ingestTables()"| OAPI
    BW -->|"upsert"| TABLES
    BW -->|"enqueue table + rev-hist jobs"| TQ
    BW -->|"enqueue rev-hist jobs"| RQ

    TQ --> TW
    TW -->|"getRecords()"| OAPI
    TW -->|"upsert"| PAGES

    RQ --> RW
    RW -->|"scrape cookies"| SESS
    RW -->|"fetch revision HTML"| WEB
    RW -->|"save"| REVH

    %% ── Log tee → SSE ────────────────────────────────────────────────────────
    Workers -->|"log()"| LOG
    LOG -->|"LogListener callback"| SRS
    SRS -->|"SSE event: log"| ES
    ES -->|"append line"| SStore
    SStore -->|"logs signal"| SCOMP

    %% ── Completion → grid refresh ────────────────────────────────────────────
    SRS -->|"poll getJobCounts()"| Queue
    SRS -->|"SSE event: status=completed"| ES
    ES -->|"completedAt signal"| SStore
    SStore -->|"effect(completedAt)"| DCOMP
    DCOMP -->|"GET /entities/:name/data"| HTTP
    HTTP -->|"query"| Mongo
    Mongo -->|"paginated rows"| DCOMP

    %% ── OAuth (integrations) ─────────────────────────────────────────────────
    INTS -->|"redirect to OAuth start"| OAPI
    OAPI -->|"callback + tokens"| TOKENS

    %% ── Dashboard composition ────────────────────────────────────────────────
    DASH --- INTS
    DASH --- SCOMP
    DASH --- DCOMP

    %% ── Styles ───────────────────────────────────────────────────────────────
    classDef store  fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a
    classDef worker fill:#dcfce7,stroke:#22c55e,color:#14532d
    classDef queue  fill:#fef9c3,stroke:#eab308,color:#713f12
    classDef db     fill:#f3e8ff,stroke:#a855f7,color:#3b0764
    classDef ext    fill:#fee2e2,stroke:#ef4444,color:#7f1d1d
    classDef svc    fill:#ffedd5,stroke:#f97316,color:#7c2d12

    class SStore,ES store
    class CW,BW,TW,RW worker
    class CQ,BQ,TQ,RQ queue
    class BASES,TABLES,PAGES,REVH,SESS,TOKENS db
    class OAPI,WEB ext
    class SRS,SO,LOG svc
```

---

## 3. Run State Machine

```mermaid
stateDiagram-v2
    [*] --> idle

    idle --> logging_in : POST /scraping/run\n(fresh start)
    completed --> logging_in : POST /scraping/run\n(new run)
    failed --> logging_in : POST /scraping/run\n(retry)

    logging_in --> awaiting_mfa : startLogin() →\nstate = awaiting_mfa
    logging_in --> running : startLogin() →\nstate = active

    awaiting_mfa --> running : re-POST /scraping/run\nafter MFA submitted\n(session now active)

    running --> completed : all queues idle\n(completion watcher)
    running --> failed : bases or tables\njob failed\n(QueueEvents)

    completed --> [*] : grid auto-refreshes
    failed --> [*] : error panel shown\ninstead of grid

    note right of awaiting_mfa
        User submits TOTP via
        POST /scraping/mfa,
        then frontend re-POSTs
        /scraping/run
    end note

    note right of running
        SSE stream open:
        live log lines pushed
        to ScrapingComponent
    end note
```

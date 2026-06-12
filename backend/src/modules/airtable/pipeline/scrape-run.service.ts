import { randomUUID } from 'node:crypto';
import { QueueEvents } from 'bullmq';
import type { Response } from 'express';
import {
  addLogListener,
  removeLogListener,
  type LogEntry,
} from '../../../core/logger/index.js';
import type { Logger } from '../../../core/logger/index.js';
import type { BullMqQueueManager } from '../../../infrastructure/queue/bullmq-queue-manager.js';
import type { IBaseRepository } from '../models/base.repository.interface.js';
import type { IPageRepository } from '../models/page.repository.interface.js';
import type { ISessionOrchestrator } from '../scraping/session-orchestrator.interface.js';

export type RunStatus =
  | 'idle'
  | 'logging_in'
  | 'awaiting_mfa'
  | 'running'
  | 'completed'
  | 'failed';

export interface ScrapeRun {
  runId: string;
  status: RunStatus;
  error: string | null;
  sessionId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export type StartRunResult =
  | { runId: string; status: RunStatus }
  | { conflict: true };

// Log contexts produced by the pipeline workers
const PIPELINE_CONTEXTS = new Set([
  'cron-processor',
  'bases-processor',
  'tables-processor',
  'revision-history-processor',
  'session',
  'revision',
  'ingest',
]);

const LOG_BUFFER_MAX = 1000;
const QUEUE_NAMES = ['cron', 'bases', 'tables', 'revision-history'] as const;

export class ScrapeRunService {
  private currentRun: ScrapeRun | null = null;
  private readonly logBuffer: LogEntry[] = [];
  private readonly sseClients = new Set<Response>();
  private completionTimer?: NodeJS.Timeout;
  private queueEvents: QueueEvents[] = [];
  private hasSeenWork = false;

  constructor(
    private readonly queueManager: BullMqQueueManager,
    private readonly baseRepository: IBaseRepository,
    private readonly pageRepository: IPageRepository,
    private readonly sessionOrchestrator: ISessionOrchestrator,
    private readonly redisConfig: { host: string; port: number },
    private readonly log: Logger,
  ) {}

  getCurrentRun(): ScrapeRun | null {
    return this.currentRun;
  }

  /**
   * Returns immediately with the current status.
   * All blocking work (login, MFA wait, pipeline) runs in the background and
   * communicates progress to SSE clients.
   */
  start(): StartRunResult {
    const cur = this.currentRun;

    if (cur?.status === 'logging_in' || cur?.status === 'running') {
      return { conflict: true };
    }

    if (cur?.status === 'awaiting_mfa') {
      return this.continueAfterMfa();
    }

    return this.startFresh();
  }

  // ── SSE client management ─────────────────────────────────────────────────

  addSseClient(res: Response): void {
    this.sseClients.add(res);

    // Replay buffered logs
    for (const entry of this.logBuffer) {
      this.pushEvent(res, 'log', entry);
    }

    const cur = this.currentRun;
    if (!cur) return;

    // Replay terminal state immediately so a late-joining client doesn't hang
    if (cur.status === 'completed' || cur.status === 'failed') {
      this.pushEvent(res, 'status', { status: cur.status, error: cur.error });
      res.end();
      this.sseClients.delete(res);
      return;
    }

    // If client reconnects while waiting for MFA, re-send the awaiting_mfa event
    if (cur.status === 'awaiting_mfa' && cur.sessionId) {
      this.pushEvent(res, 'status', {
        status: 'awaiting_mfa',
        sessionId: cur.sessionId,
        error: null,
      });
    }
  }

  removeSseClient(res: Response): void {
    this.sseClients.delete(res);
  }

  // ── Private: run lifecycle ────────────────────────────────────────────────

  private startFresh(): StartRunResult {
    const runId = randomUUID();
    this.currentRun = {
      runId,
      status: 'logging_in',
      error: null,
      sessionId: null,
      startedAt: new Date(),
      finishedAt: null,
    };
    this.logBuffer.length = 0;
    this.log.info('Scrape run started', { runId });

    // Fire login in the background — do NOT await; the HTTP response goes out
    // immediately with status "logging_in". Status transitions are pushed to
    // SSE clients as they happen.
    void this.doLogin(runId);

    return { runId, status: 'logging_in' };
  }

  /**
   * Runs in the background after startFresh(). Awaits MFA detection, then
   * either pauses (broadcasting awaiting_mfa) or proceeds to executeRun().
   */
  private async doLogin(runId: string): Promise<void> {
    try {
      // Always invalidate any existing session so that a fresh Puppeteer login
      // is performed. This guarantees 2FA is detected on every run rather than
      // silently reusing old cookies (which look valid for airtable.com but may
      // fail for internal APIs, and bypass the MFA dialog entirely).
      await this.sessionOrchestrator.invalidateSession();

      const loginResult = await this.sessionOrchestrator.startLogin();

      // Guard: the run may have been superseded while login was in progress
      if (!this.currentRun || this.currentRun.runId !== runId) return;

      if (loginResult.state === 'awaiting_mfa') {
        this.currentRun.status = 'awaiting_mfa';
        this.currentRun.sessionId = loginResult.sessionId;
        this.broadcast('status', {
          status: 'awaiting_mfa',
          sessionId: loginResult.sessionId,
          error: null,
        });
        return; // pipeline starts only after MFA continuation
      }

      // Phase1 fires as soon as MFA is ruled out, but performLogin() is still
      // running (network-idle wait → CDP cookie capture → DB writes).  Awaiting
      // the full login here ensures activePage is set and cookies are saved
      // before any pipeline worker can call makeBrowserFetch().  Without this,
      // a failure in the tail of performLogin() leaves workers with no session.
      await this.sessionOrchestrator.awaitLoginComplete();

      await this.executeRun();
    } catch (err) {
      if (this.currentRun?.runId === runId) {
        this.finishRun('failed', err instanceof Error ? err.message : String(err));
      }
    }
  }

  /**
   * Called when the user re-POSTs /scraping/run after submitting the MFA code.
   * Transitions back to "logging_in" immediately and waits for the Puppeteer
   * login to finish (post-MFA navigation + cookie capture) in the background.
   */
  private continueAfterMfa(): StartRunResult {
    const cur = this.currentRun!;
    cur.status = 'logging_in';

    void this.doLoginContinue(cur.runId);

    return { runId: cur.runId, status: 'logging_in' };
  }

  private async doLoginContinue(runId: string): Promise<void> {
    try {
      // Wait for the in-flight performLogin() to finish (navigation + cookies
      // + secretSocketId capture all happen after the MFA code is submitted).
      await this.sessionOrchestrator.awaitLoginComplete();

      if (!this.currentRun || this.currentRun.runId !== runId) return;

      await this.executeRun();
    } catch (err) {
      if (this.currentRun?.runId === runId) {
        this.finishRun('failed', err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async executeRun(): Promise<void> {
    const cur = this.currentRun!;
    cur.status = 'running';
    this.hasSeenWork = false;

    // Broadcast so the frontend chip updates immediately
    this.broadcast('status', { status: 'running', error: null });

    const listener = this.makeListener();
    addLogListener(listener);

    try {
      await this.obliterateQueues();
      await this.baseRepository.resetAllForReprocessing();
      await this.pageRepository.resetAllRevisionStatus();

      await this.queueManager
        .getQueue('cron')
        .add('pipeline-tick', { scheduledAt: new Date().toISOString() });

      this.log.info('Pipeline bootstrap enqueued', { runId: cur.runId });
      this.startCompletionWatcher(listener);
      this.startFailureWatchers(listener);
    } catch (err) {
      removeLogListener(listener);
      this.finishRun('failed', err instanceof Error ? err.message : String(err));
    }
  }

  // ── Private: log listener ─────────────────────────────────────────────────

  private makeListener() {
    return (entry: LogEntry): void => {
      const ctx = entry.context ?? '';
      const relevant = [...PIPELINE_CONTEXTS].some(
        (c) => ctx === c || ctx.endsWith(`:${c}`),
      );
      if (!relevant) return;

      this.logBuffer.push(entry);
      if (this.logBuffer.length > LOG_BUFFER_MAX) this.logBuffer.shift();
      this.broadcast('log', entry);
    };
  }

  // ── Private: queue helpers ────────────────────────────────────────────────

  private async obliterateQueues(): Promise<void> {
    for (const name of QUEUE_NAMES) {
      await this.queueManager.getQueue(name).obliterate({ force: true });
    }
    this.log.info('Queues obliterated');
  }

  private startCompletionWatcher(listener: (e: LogEntry) => void): void {
    this.completionTimer = setInterval(() => {
      void this.checkCompletion(listener);
    }, 2_000);
  }

  private async checkCompletion(listener: (e: LogEntry) => void): Promise<void> {
    if (this.currentRun?.status !== 'running') {
      clearInterval(this.completionTimer);
      return;
    }

    const counts = await Promise.all(
      QUEUE_NAMES.map((n) =>
        this.queueManager
          .getQueue(n)
          .getJobCounts('waiting', 'active', 'delayed', 'prioritized'),
      ),
    );

    const total = counts.reduce(
      (sum, c) =>
        sum +
        (c['waiting'] ?? 0) +
        (c['active'] ?? 0) +
        (c['delayed'] ?? 0) +
        (c['prioritized'] ?? 0),
      0,
    );

    if (total > 0) this.hasSeenWork = true;

    if (this.hasSeenWork && total === 0) {
      clearInterval(this.completionTimer);
      this.teardownQueueEvents();
      removeLogListener(listener);
      this.finishRun('completed', null);
    }
  }

  private startFailureWatchers(listener: (e: LogEntry) => void): void {
    const conn = { host: this.redisConfig.host, port: this.redisConfig.port };

    for (const queueName of ['bases', 'tables'] as const) {
      const qe = new QueueEvents(queueName, { connection: conn });

      qe.on('failed', ({ failedReason }) => {
        if (this.currentRun?.status !== 'running') return;
        clearInterval(this.completionTimer);
        this.teardownQueueEvents();
        removeLogListener(listener);
        this.finishRun('failed', failedReason);
      });

      this.queueEvents.push(qe);
    }
  }

  private teardownQueueEvents(): void {
    for (const qe of this.queueEvents) void qe.close();
    this.queueEvents = [];
  }

  // ── Private: SSE helpers ──────────────────────────────────────────────────

  private finishRun(status: 'completed' | 'failed', error: string | null): void {
    if (!this.currentRun) return;
    this.currentRun.status = status;
    this.currentRun.error = error;
    this.currentRun.finishedAt = new Date();
    this.log.info('Scrape run finished', {
      runId: this.currentRun.runId,
      status,
      error: error ?? undefined,
    });
    this.broadcast('status', { status, error });
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
  }

  private broadcast(event: string, data: unknown): void {
    for (const res of this.sseClients) this.pushEvent(res, event, data);
  }

  private pushEvent(res: Response, event: string, data: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.sseClients.delete(res);
    }
  }
}

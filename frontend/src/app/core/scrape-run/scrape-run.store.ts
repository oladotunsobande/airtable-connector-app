import { Injectable, signal, inject, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { RunStatus, StartRunResponse } from '../models/api.models';

const API_BASE = 'http://127.0.0.1:3000';

@Injectable({ providedIn: 'root' })
export class ScrapeRunStore {
  private readonly http = inject(HttpClient);
  private readonly ngZone = inject(NgZone);
  private eventSource?: EventSource;

  readonly status = signal<RunStatus>('idle');
  readonly error = signal<string | null>(null);
  readonly logs = signal<string[]>([]);
  readonly completedAt = signal<Date | null>(null);
  readonly sessionId = signal<string | null>(null);

  start(): void {
    const isMfaContinuation = this.status() === 'awaiting_mfa';

    if (!isMfaContinuation) {
      // Fresh start: reset state and open the SSE stream immediately so that
      // the awaiting_mfa event (broadcast ~20s later) is not missed.
      this.logs.set([]);
      this.error.set(null);
      this.sessionId.set(null);
      this.status.set('logging_in');
      this.openStream();
    }

    this.http.post<StartRunResponse>(`${API_BASE}/scraping/run`, {}).subscribe({
      next: (res) => {
        // Backend now returns immediately with logging_in (or logging_in
        // again for MFA continuation). Status transitions come via SSE.
        this.status.set(res.status);
      },
      error: (err) => {
        console.error(err);
        this.error.set('Failed to start scraping run.');
        this.status.set('failed');
        this.closeStream();
      },
    });
  }

  openStream(): void {
    this.closeStream();
    this.eventSource = new EventSource(`${API_BASE}/scraping/run/stream`);

    this.eventSource.addEventListener('log', (e: MessageEvent<string>) => {
      // EventSource callbacks run outside Angular's zone. ngZone.run() ensures
      // signal writes trigger change detection so the log panel re-renders.
      this.ngZone.run(() => {
        const entry = JSON.parse(e.data) as {
          level: string;
          context?: string;
          message: string;
        };
        const prefix = entry.context ? `[${entry.context}] ` : '';
        const line = `${entry.level.toUpperCase()}  ${prefix}${entry.message}`;
        this.logs.update((lines) => [...lines, line]);
      });
    });

    this.eventSource.addEventListener('status', (e: MessageEvent<string>) => {
      this.ngZone.run(() => {
        const data = JSON.parse(e.data) as {
          status: RunStatus;
          error: string | null;
          sessionId?: string;
        };

        // Capture sessionId when the backend signals MFA is needed
        if (data.status === 'awaiting_mfa' && data.sessionId) {
          this.sessionId.set(data.sessionId);
        }

        this.status.set(data.status);
        this.error.set(data.error);

        if (data.status === 'completed') {
          this.completedAt.set(new Date());
        }

        // Only close the stream on terminal states, not on awaiting_mfa/running
        if (data.status === 'completed' || data.status === 'failed') {
          this.closeStream();
        }
      });
    });
  }

  closeStream(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = undefined;
    }
  }
}

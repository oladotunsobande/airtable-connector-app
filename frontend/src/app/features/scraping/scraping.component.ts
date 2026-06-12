import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { ApiService } from '../../core/api/api.service';
import { MfaDialogComponent } from './mfa-dialog.component';

@Component({
  selector: 'app-scraping',
  imports: [
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatDialogModule,
    MatProgressSpinnerModule,
    MatChipsModule,
  ],
  templateUrl: './scraping.component.html',
  styleUrl: './scraping.component.scss',
})
export class ScrapingComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);

  sessionState = signal<string | null>(null);
  currentSessionId = signal<string | null>(null);
  isStarting = signal(false);
  errorMsg = signal('');

  private pollHandle?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.refreshSession();
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  refreshSession(): void {
    this.api.getScrapingSession().subscribe({
      next: (s) => {
        this.sessionState.set(s.state);
        this.currentSessionId.set(s.sessionId);
      },
      error: () => {
        this.errorMsg.set('Could not reach backend. Ensure it is running on port 3000.');
      },
    });
  }

  startScraping(): void {
    this.isStarting.set(true);
    this.errorMsg.set('');

    this.api.startScraping().subscribe({
      next: (res) => {
        this.isStarting.set(false);
        this.currentSessionId.set(res.sessionId);
        this.sessionState.set(res.state);

        if (res.state === 'awaiting_mfa') {
          this.openMfaDialog();
        } else {
          this.startPolling();
        }
      },
      error: (err) => {
        this.isStarting.set(false);
        this.errorMsg.set(err?.error?.message ?? 'Failed to start scraping session.');
      },
    });
  }

  openMfaDialog(): void {
    const sessionId = this.currentSessionId();
    if (!sessionId) return;

    const ref = this.dialog.open(MfaDialogComponent, {
      width: '400px',
      data: { sessionId },
      disableClose: true,
    });

    ref.afterClosed().subscribe((submitted: boolean) => {
      if (submitted) {
        this.startPolling();
      }
    });
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollHandle = setInterval(() => {
      this.api.getScrapingSession().subscribe({
        next: (s) => {
          this.sessionState.set(s.state);
          if (s.state === 'active' || s.state === 'expired' || s.state === 'invalid') {
            this.stopPolling();
          }
        },
      });
    }, 3000);
  }

  private stopPolling(): void {
    if (this.pollHandle !== undefined) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
  }
}

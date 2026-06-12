import { Component, inject, effect, ViewChild, ElementRef, OnDestroy } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { ScrapeRunStore } from '../../core/scrape-run/scrape-run.store';
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
export class ScrapingComponent implements OnDestroy {
  protected readonly store = inject(ScrapeRunStore);
  private readonly dialog = inject(MatDialog);

  @ViewChild('logPanel') logPanelRef?: ElementRef<HTMLDivElement>;

  private mfaDialogRef?: MatDialogRef<MfaDialogComponent>;
  private mfaDialogSessionId: string | null = null;

  constructor() {
    // Open the MFA dialog when the store enters awaiting_mfa, and re-open it
    // when the session ID changes while a dialog is already open. Without the
    // session ID check, a dialog opened for an old session stays up and submits
    // with a stale ID that the backend no longer has a waiter for.
    effect(() => {
      const status = this.store.status();
      const sessionId = this.store.sessionId();

      if (status === 'awaiting_mfa' && sessionId) {
        if (this.mfaDialogRef && this.mfaDialogSessionId !== sessionId) {
          // New login produced a different session while the dialog is open.
          this.mfaDialogRef.close(false);
          this.mfaDialogRef = undefined;
          this.mfaDialogSessionId = null;
        }
        if (!this.mfaDialogRef) {
          this.openMfaDialog(sessionId);
        }
      }
    });

    // Auto-scroll log panel when logs grow
    effect(() => {
      this.store.logs(); // track signal
      requestAnimationFrame(() => {
        const el = this.logPanelRef?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }

  ngOnDestroy(): void {
    this.store.closeStream();
  }

  startScraping(): void {
    this.store.start();
  }

  get isActive(): boolean {
    const s = this.store.status();
    return s === 'logging_in' || s === 'awaiting_mfa' || s === 'running';
  }

  private openMfaDialog(sessionId: string): void {
    const ref = this.dialog.open(MfaDialogComponent, {
      width: '400px',
      data: { sessionId },
      disableClose: true,
    });
    this.mfaDialogRef = ref;
    this.mfaDialogSessionId = sessionId;

    ref.afterClosed().subscribe((submitted: boolean) => {
      // Only clear state if this ref is still the active dialog (a session
      // change may have already replaced mfaDialogRef with a newer one).
      if (this.mfaDialogRef === ref) {
        this.mfaDialogRef = undefined;
        this.mfaDialogSessionId = null;
      }
      if (submitted) {
        this.store.start();
      }
    });
  }
}

import { Component, inject, effect, ViewChild, ElementRef, OnDestroy } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
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

  private mfaDialogOpen = false;

  constructor() {
    // Open MFA dialog when the store enters awaiting_mfa
    effect(() => {
      if (this.store.status() === 'awaiting_mfa' && !this.mfaDialogOpen) {
        this.openMfaDialog();
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

  private openMfaDialog(): void {
    const sessionId = this.store.sessionId();
    if (!sessionId) return;

    this.mfaDialogOpen = true;
    const ref = this.dialog.open(MfaDialogComponent, {
      width: '400px',
      data: { sessionId },
      disableClose: true,
    });

    ref.afterClosed().subscribe((submitted: boolean) => {
      this.mfaDialogOpen = false;
      if (submitted) {
        // MFA code accepted — re-POST /scraping/run to continue the run
        this.store.start();
      }
    });
  }
}

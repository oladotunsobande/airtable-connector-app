import { Component } from '@angular/core';
import { MatCardModule } from '@angular/material/card';

@Component({
  selector: 'app-scraping',
  imports: [MatCardModule],
  template: `
    <mat-card>
      <mat-card-header>
        <mat-card-title>Scraping</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <p>Scraping controls and MFA modal will be implemented in Phase 9.</p>
      </mat-card-content>
    </mat-card>
  `,
})
export class ScrapingComponent {}

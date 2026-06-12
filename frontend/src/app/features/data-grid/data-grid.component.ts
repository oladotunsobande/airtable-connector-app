import { Component } from '@angular/core';
import { MatCardModule } from '@angular/material/card';

@Component({
  selector: 'app-data-grid',
  imports: [MatCardModule],
  template: `
    <mat-card>
      <mat-card-header>
        <mat-card-title>Raw Data</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <p>Data grid will be implemented in Phase 9.</p>
      </mat-card-content>
    </mat-card>
  `,
})
export class DataGridComponent {}

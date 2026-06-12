import { Component } from '@angular/core';
import { MatCardModule } from '@angular/material/card';

@Component({
  selector: 'app-integrations',
  imports: [MatCardModule],
  template: `
    <mat-card>
      <mat-card-header>
        <mat-card-title>Integrations</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <p>OAuth connect flow will be implemented in Phase 9.</p>
      </mat-card-content>
    </mat-card>
  `,
})
export class IntegrationsComponent {}

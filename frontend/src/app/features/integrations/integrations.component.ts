import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ApiService } from '../../core/api/api.service';
import type { Integration } from '../../core/models/api.models';

const API_BASE = 'http://127.0.0.1:3000';
const BACKEND_OAUTH_START = `${API_BASE}/auth/airtable/start`;

@Component({
  selector: 'app-integrations',
  imports: [
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './integrations.component.html',
  styleUrl: './integrations.component.scss',
})
export class IntegrationsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  integrations = signal<Integration[]>([]);
  loading = signal(true);
  statusMessage = signal('');
  statusType = signal<'success' | 'error'>('success');

  ngOnInit(): void {
    this.route.queryParams.subscribe((params) => {
      if (params['connected'] === 'true') {
        this.statusMessage.set('Successfully connected to Airtable.');
        this.statusType.set('success');
      } else if (params['error']) {
        this.statusMessage.set(`OAuth error: ${params['error']}`);
        this.statusType.set('error');
      }
    });

    this.loadIntegrations();
  }

  connect(): void {
    window.location.href = BACKEND_OAUTH_START;
  }

  disconnect(_integration: Integration): void {
    console.log('na disconnect');
    fetch(`${API_BASE}/auth/airtable/disconnect`, {
      method: 'DELETE',
    }).finally(() => this.loadIntegrations());
  }

  private loadIntegrations(): void {
    this.loading.set(true);
    this.api.getIntegrations().subscribe({
      next: (list) => {
        this.integrations.set(list);
        this.loading.set(false);
      },
      error: (error) => {
        console.error(error);
        this.loading.set(false);
        if (!this.statusMessage()) {
          this.statusMessage.set(
            'Could not reach backend. Ensure it is running on port 3000.',
          );
          this.statusType.set('error');
        }
      },
    });
  }
}

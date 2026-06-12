import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  Integration,
  EntityMeta,
  EntityPage,
  QueryOptions,
  RunSnapshot,
  StartRunResponse,
} from '../models/api.models';

const API_BASE = 'http://127.0.0.1:3000';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  getIntegrations(): Observable<Integration[]> {
    return this.http.get<Integration[]>(`${API_BASE}/integrations`);
  }

  getEntities(): Observable<EntityMeta[]> {
    return this.http.get<EntityMeta[]>(`${API_BASE}/entities`);
  }

  getEntityData(name: string, options: QueryOptions): Observable<EntityPage> {
    const params: Record<string, string> = {
      page: String(options.page),
      pageSize: String(options.pageSize),
    };
    if (options.search) params['search'] = options.search;
    if (options.sortField) params['sortField'] = options.sortField;
    if (options.sortDir) params['sortDir'] = options.sortDir;
    if (options.filterField) params['filterField'] = options.filterField;
    if (options.filterOp) params['filterOp'] = options.filterOp;
    if (options.filterValue) params['filterValue'] = options.filterValue;

    return this.http.get<EntityPage>(`${API_BASE}/entities/${name}/data`, {
      params,
    });
  }

  startRun(): Observable<StartRunResponse> {
    return this.http.post<StartRunResponse>(`${API_BASE}/scraping/run`, {});
  }

  getRunStatus(): Observable<RunSnapshot> {
    return this.http.get<RunSnapshot>(`${API_BASE}/scraping/run`);
  }

  submitMfa(sessionId: string, code: string): Observable<void> {
    return this.http.post<void>(`${API_BASE}/scraping/mfa`, {
      sessionId,
      code,
    });
  }
}

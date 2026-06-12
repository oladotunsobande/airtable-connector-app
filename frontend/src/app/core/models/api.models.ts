export interface Integration {
  id: string;
  name: string;
  connected: boolean;
}

export interface EntityMeta {
  name: string;
  label: string;
  count: number;
}

export interface EntityPage {
  data: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  fields: string[];
}

export interface QueryOptions {
  page: number;
  pageSize: number;
  search?: string;
  sortField?: string;
  sortDir?: 'asc' | 'desc';
  filterField?: string;
  filterOp?: 'eq' | 'contains' | 'gt' | 'lt';
  filterValue?: string;
}

export interface ScrapingSession {
  sessionId: string | null;
  state: string | null;
  hasCookies: boolean;
  validatedAt: string | null;
}

export interface StartSessionResponse {
  sessionId: string;
  state: string;
}

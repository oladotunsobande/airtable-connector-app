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

export type RunStatus =
  | 'idle'
  | 'logging_in'
  | 'awaiting_mfa'
  | 'running'
  | 'completed'
  | 'failed';

export interface RunSnapshot {
  runId: string | null;
  status: RunStatus;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StartRunResponse {
  runId: string;
  status: RunStatus;
  sessionId?: string;
}

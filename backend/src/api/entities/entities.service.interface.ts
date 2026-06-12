export interface EntityMeta {
  name: string;
  label: string;
  count: number;
}

export type FilterOp = 'eq' | 'contains' | 'gt' | 'lt';

export interface QueryOptions {
  page: number;
  pageSize: number;
  search?: string;
  sortField?: string;
  sortDir?: 'asc' | 'desc';
  filterField?: string;
  filterOp?: FilterOp;
  filterValue?: string;
}

export interface EntityPage {
  data: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  fields: string[];
}

export interface IEntitiesService {
  listEntities(): Promise<EntityMeta[]>;
  queryEntity(entityName: string, options: QueryOptions): Promise<EntityPage>;
}

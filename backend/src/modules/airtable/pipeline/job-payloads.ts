export interface CronJobPayload {
  scheduledAt: string;
}

export interface BasesJobPayload {
  baseId: string;
  baseName: string;
}

export interface TablesJobPayload {
  baseId: string;
  tableId: string;
  tableName: string;
}

export interface RevisionHistoryJobPayload {
  baseId: string;
  tableId: string;
  pageId: string;
}

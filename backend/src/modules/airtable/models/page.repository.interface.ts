export type RevisionStatus = 'pending' | 'scraped' | 'error';

export interface PageDocument {
  airtableId: string;
  baseId: string;
  tableId: string;
  fields: Record<string, unknown>;
  createdTime: Date;
  revisionScrapedAt: Date | null;
  revisionStatus: RevisionStatus;
}

export interface IPageRepository {
  upsert(page: Pick<PageDocument, 'airtableId' | 'baseId' | 'tableId' | 'fields' | 'createdTime'>): Promise<PageDocument>;
  findPendingRevision(baseId: string, limit: number): Promise<PageDocument[]>;
  findPendingRevisionByTable(baseId: string, tableId: string, limit: number): Promise<PageDocument[]>;
  findByTableId(tableId: string): Promise<PageDocument[]>;
  updateRevisionStatus(airtableId: string, status: RevisionStatus, scrapedAt?: Date): Promise<void>;
  count(): Promise<number>;
}

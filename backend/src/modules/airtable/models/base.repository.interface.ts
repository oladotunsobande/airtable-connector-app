export type ProcessingStatus = 'idle' | 'queued' | 'processing' | 'error';

export interface ProcessingError {
  message: string;
  occurredAt: Date;
}

export interface BaseDocument {
  airtableId: string;
  name: string;
  permissionLevel: string;
  processingStatus: ProcessingStatus;
  processingErrors: ProcessingError[];
  lastProcessedAt: Date | null;
  lastSuccessfulAt: Date | null;
}

export interface IBaseRepository {
  upsert(base: Pick<BaseDocument, 'airtableId' | 'name' | 'permissionLevel'>): Promise<BaseDocument>;
  findById(airtableId: string): Promise<BaseDocument | null>;
  findAll(): Promise<BaseDocument[]>;
  findForProcessing(limit: number): Promise<BaseDocument[]>;
  updateStatus(airtableId: string, status: ProcessingStatus, error?: ProcessingError): Promise<void>;
  markSuccessful(airtableId: string): Promise<void>;
  count(): Promise<number>;
  resetAllForReprocessing(): Promise<void>;
}

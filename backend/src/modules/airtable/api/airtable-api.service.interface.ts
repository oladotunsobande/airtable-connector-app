export interface AirtableBase {
  id: string;
  name: string;
  permissionLevel: string;
}

export interface AirtableField {
  id: string;
  name: string;
  type: string;
  options?: Record<string, unknown>;
}

export interface AirtableTable {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: AirtableField[];
}

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface IAirtableApiService {
  getBases(): Promise<AirtableBase[]>;
  getTables(baseId: string): Promise<AirtableTable[]>;
  getRecords(baseId: string, tableId: string): AsyncGenerator<AirtableRecord[]>;
}

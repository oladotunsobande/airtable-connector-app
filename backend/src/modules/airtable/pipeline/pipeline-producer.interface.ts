export interface IPipelineProducer {
  enqueueBase(baseId: string): Promise<void>;
  enqueueTable(baseId: string, tableId: string): Promise<void>;
  enqueueRevisionHistory(baseId: string, tableId: string, rowId: string): Promise<void>;
}

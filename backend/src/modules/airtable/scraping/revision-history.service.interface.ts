export interface IRevisionHistoryService {
  /**
   * Fetches all revision history for a given row/ticket, parses it, and
   * persists it to the DB. Automatically re-authenticates via the session
   * orchestrator if cookies expire mid-run.
   */
  scrapeForPage(baseId: string, tableId: string, rowId: string): Promise<void>;
}

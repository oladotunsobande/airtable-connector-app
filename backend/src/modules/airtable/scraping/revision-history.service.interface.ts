import type { RevisionHistoryDocument } from '../models/revision-history.repository.interface.js';

export interface IRevisionHistoryService {
  /**
   * Fetches all revision history entries (paginated) for a given row/ticket.
   * Automatically re-authenticates if the session expires mid-run.
   */
  fetchForTicket(rowId: string): Promise<RevisionHistoryDocument[]>;
}

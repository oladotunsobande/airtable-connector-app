import type { RevisionHistoryDocument } from '../models/revision-history.repository.interface.js';

export interface RawActivityItem {
  activityId: string;
  ticketId: string;
  createdTime: string;
  originatingUserId: string;
  diffRowHtml: string;
  groupType: string;
}

export interface IRevisionHistoryParser {
  /**
   * Parses raw activity items from the API response.
   * Filters to only Status and Assignee changes.
   * Returns null for items that don't match tracked column types.
   */
  parse(item: RawActivityItem): RevisionHistoryDocument | null;
}

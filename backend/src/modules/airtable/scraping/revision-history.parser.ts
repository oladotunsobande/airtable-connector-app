import { parse } from 'node-html-parser';
import type {
  IRevisionHistoryParser,
  RawActivityItem,
} from './revision-history-parser.interface.js';
import type { RevisionHistoryDocument } from '../models/revision-history.repository.interface.js';
import type { IColumnStrategy } from './strategies/column-strategy.interface.js';
import { StatusColumnStrategy } from './strategies/status-column.strategy.js';
import { AssigneeColumnStrategy } from './strategies/assignee-column.strategy.js';

/**
 * CSS selector for the column-name header inside a diff row.
 * Airtable renders the changed column as:
 *   <span class="micro strong caps" columnId="fldXXX">Column Name</span>
 */
const COLUMN_HEADER_SELECTOR = '.micro.strong.caps';

export class RevisionHistoryParser implements IRevisionHistoryParser {
  private readonly strategies: IColumnStrategy[];

  constructor() {
    this.strategies = [new StatusColumnStrategy(), new AssigneeColumnStrategy()];
  }

  parse(item: RawActivityItem): RevisionHistoryDocument | null {
    if (item.groupType !== 'cellUpdate') return null;
    if (!item.diffRowHtml) return null;

    const root = parse(item.diffRowHtml);
    const headerEl = root.querySelector(COLUMN_HEADER_SELECTOR);
    if (!headerEl) return null;

    const columnName = headerEl.textContent.trim();
    const strategy = this.strategies.find((s) => s.canHandle(columnName));
    if (!strategy) return null;

    const { oldValue, newValue } = strategy.extractValues(root);

    return {
      uuid: item.activityId,
      issueId: item.ticketId,
      columnType: strategy.columnType,
      oldValue,
      newValue,
      createdDate: new Date(item.createdTime),
      authoredBy: item.originatingUserId,
    };
  }
}

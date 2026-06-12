import type { HTMLElement } from 'node-html-parser';

export interface ParsedValues {
  oldValue: string | null;
  newValue: string | null;
}

export interface IColumnStrategy {
  /** The normalised column type stored on RevisionHistoryDocument. */
  readonly columnType: string;
  /** Returns true when this strategy should handle the given column header text. */
  canHandle(columnName: string): boolean;
  /** Extracts old and new values from the parsed diff HTML root. */
  extractValues(root: HTMLElement): ParsedValues;
}

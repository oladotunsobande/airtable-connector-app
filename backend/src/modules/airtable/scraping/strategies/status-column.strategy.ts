import type { HTMLElement } from 'node-html-parser';
import type { IColumnStrategy, ParsedValues } from './column-strategy.interface.js';

/**
 * Selectors for pill elements in Airtable's single-select diff HTML.
 * Tried in order; first match wins. Update here if Airtable changes its markup.
 *
 * Expected HTML shape:
 *   <span class="micro strong caps" columnId="fldXXX">Status</span>
 *   <span class="pill cellChangeDiff-old">Old Value</span>
 *   <span class="pill cellChangeDiff-new">New Value</span>
 *
 * Fallback: if the old/new CSS classes are absent, take positional
 * pills[0] = old, pills[1] = new.
 */
function text(el: HTMLElement | null): string | null {
  return el ? el.textContent.trim() || null : null;
}

export class StatusColumnStrategy implements IColumnStrategy {
  readonly columnType = 'Status';

  canHandle(columnName: string): boolean {
    return columnName.toLowerCase() === 'status';
  }

  extractValues(root: HTMLElement): ParsedValues {
    const explicitOld = root.querySelector('.cellChangeDiff-old');
    const explicitNew = root.querySelector('.cellChangeDiff-new');

    if (explicitOld) {
      return { oldValue: text(explicitOld), newValue: text(explicitNew) };
    }

    if (explicitNew) {
      // Value set for the first time — no prior state.
      return { oldValue: null, newValue: text(explicitNew) };
    }

    // Positional fallback: first pill = old, second pill = new.
    const pills = root.querySelectorAll('.pill');
    return {
      oldValue: text(pills[0] ?? null),
      newValue: text(pills[1] ?? null),
    };
  }
}

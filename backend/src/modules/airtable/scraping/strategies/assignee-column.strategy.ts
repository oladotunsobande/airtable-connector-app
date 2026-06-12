import type { HTMLElement } from 'node-html-parser';
import type { IColumnStrategy, ParsedValues } from './column-strategy.interface.js';

/**
 * Selectors for collaborator tokens in Airtable's collaborator diff HTML.
 * Update here if Airtable changes its markup.
 *
 * Expected HTML shape:
 *   <span class="micro strong caps" columnId="fldYYY">Assignee</span>
 *   <span class="collaboratorToken cellChangeDiff-old">Alice</span>
 *   <span class="collaboratorToken cellChangeDiff-new">Bob</span>
 *
 * Fallback: first/last .collaboratorToken, then any name-bearing element.
 */
function text(el: HTMLElement | null): string | null {
  return el ? el.textContent.trim() || null : null;
}

export class AssigneeColumnStrategy implements IColumnStrategy {
  readonly columnType = 'Assignee';

  canHandle(columnName: string): boolean {
    const n = columnName.toLowerCase();
    return n === 'assignee' || n === 'assigned to';
  }

  extractValues(root: HTMLElement): ParsedValues {
    const explicitOld =
      root.querySelector('.collaboratorToken.cellChangeDiff-old') ??
      root.querySelector('.collaborator.cellChangeDiff-old') ??
      root.querySelector('.cellChangeDiff-old');

    const explicitNew =
      root.querySelector('.collaboratorToken.cellChangeDiff-new') ??
      root.querySelector('.collaborator.cellChangeDiff-new') ??
      root.querySelector('.cellChangeDiff-new');

    if (explicitOld) {
      return { oldValue: text(explicitOld), newValue: text(explicitNew) };
    }

    if (explicitNew) {
      return { oldValue: null, newValue: text(explicitNew) };
    }

    // Positional fallback — `:first-of-type` is tag-based, so use querySelectorAll + index.
    const tokens =
      root.querySelectorAll('.collaboratorToken').length > 0
        ? root.querySelectorAll('.collaboratorToken')
        : root.querySelectorAll('.collaborator');
    return {
      oldValue: text(tokens[0] ?? null),
      newValue: text(tokens[1] ?? null),
    };
  }
}

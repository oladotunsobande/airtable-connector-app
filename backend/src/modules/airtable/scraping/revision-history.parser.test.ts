import { describe, it, expect, beforeEach } from 'vitest';
import { RevisionHistoryParser } from './revision-history.parser.js';
import type { RawActivityItem } from './revision-history-parser.interface.js';

// ── HTML fixtures ─────────────────────────────────────────────────────────────
// These mirror the shape Airtable emits for cellUpdate diffs.
// If selectors break in future, update the strategy files; these tests will
// catch regressions.

const STATUS_HTML_WITH_CLASSES = `
  <div class="cellChangeDiff">
    <span class="micro strong caps" columnId="fldSTS">Status</span>
    <span class="pill cellChangeDiff-old">Todo</span>
    <span class="arrow">→</span>
    <span class="pill cellChangeDiff-new">In Progress</span>
  </div>
`;

const STATUS_HTML_POSITIONAL = `
  <div class="cellChangeDiff">
    <span class="micro strong caps" columnId="fldSTS">Status</span>
    <span class="pill">Backlog</span>
    <span class="arrow">→</span>
    <span class="pill">Done</span>
  </div>
`;

const STATUS_HTML_NULL_TO_VALUE = `
  <div class="cellChangeDiff">
    <span class="micro strong caps" columnId="fldSTS">Status</span>
    <span class="pill cellChangeDiff-new">In Review</span>
  </div>
`;

const ASSIGNEE_HTML_WITH_CLASSES = `
  <div class="cellChangeDiff">
    <span class="micro strong caps" columnId="fldASN">Assignee</span>
    <span class="collaboratorToken cellChangeDiff-old">Alice</span>
    <span class="arrow">→</span>
    <span class="collaboratorToken cellChangeDiff-new">Bob</span>
  </div>
`;

const ASSIGNEE_HTML_POSITIONAL = `
  <div class="cellChangeDiff">
    <span class="micro strong caps" columnId="fldASN">Assignee</span>
    <span class="collaboratorToken">Carol</span>
    <span class="arrow">→</span>
    <span class="collaboratorToken">Dave</span>
  </div>
`;

const UNTRACKED_COLUMN_HTML = `
  <div class="cellChangeDiff">
    <span class="micro strong caps" columnId="fldTTL">Title</span>
    <span class="pill cellChangeDiff-old">Old title</span>
    <span class="pill cellChangeDiff-new">New title</span>
  </div>
`;

const NO_HEADER_HTML = `
  <div class="cellChangeDiff">
    <span class="pill">Todo</span>
    <span class="pill">Done</span>
  </div>
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<RawActivityItem> = {}): RawActivityItem {
  return {
    activityId: 'act001',
    ticketId: 'rec001',
    createdTime: '2024-03-01T12:00:00.000Z',
    originatingUserId: 'usr001',
    diffRowHtml: STATUS_HTML_WITH_CLASSES,
    groupType: 'cellUpdate',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RevisionHistoryParser', () => {
  let parser: RevisionHistoryParser;

  beforeEach(() => {
    parser = new RevisionHistoryParser();
  });

  // ── Filtering ──────────────────────────────────────────────────────────────

  it('returns null for non-cellUpdate group types', () => {
    expect(parser.parse(makeItem({ groupType: 'comment' }))).toBeNull();
    expect(parser.parse(makeItem({ groupType: 'rowCreated' }))).toBeNull();
  });

  it('returns null when diffRowHtml is empty', () => {
    expect(parser.parse(makeItem({ diffRowHtml: '' }))).toBeNull();
  });

  it('returns null when no column header element is found', () => {
    expect(parser.parse(makeItem({ diffRowHtml: NO_HEADER_HTML }))).toBeNull();
  });

  it('returns null for untracked columns', () => {
    expect(parser.parse(makeItem({ diffRowHtml: UNTRACKED_COLUMN_HTML }))).toBeNull();
  });

  // ── Status column ──────────────────────────────────────────────────────────

  it('parses a Status change with explicit old/new classes', () => {
    const result = parser.parse(makeItem({ diffRowHtml: STATUS_HTML_WITH_CLASSES }));

    expect(result).not.toBeNull();
    expect(result?.columnType).toBe('Status');
    expect(result?.oldValue).toBe('Todo');
    expect(result?.newValue).toBe('In Progress');
  });

  it('parses a Status change positionally (no explicit classes)', () => {
    const result = parser.parse(makeItem({ diffRowHtml: STATUS_HTML_POSITIONAL }));

    expect(result?.columnType).toBe('Status');
    expect(result?.oldValue).toBe('Backlog');
    expect(result?.newValue).toBe('Done');
  });

  it('returns null oldValue when Status is set for the first time', () => {
    const result = parser.parse(makeItem({ diffRowHtml: STATUS_HTML_NULL_TO_VALUE }));

    expect(result?.columnType).toBe('Status');
    expect(result?.oldValue).toBeNull();
    expect(result?.newValue).toBe('In Review');
  });

  it('maps activityId, ticketId, createdDate, and authoredBy from the raw item', () => {
    const item = makeItem({
      activityId: 'actXYZ',
      ticketId: 'recABC',
      createdTime: '2024-06-15T08:30:00.000Z',
      originatingUserId: 'usrDEF',
    });
    const result = parser.parse(item);

    expect(result?.uuid).toBe('actXYZ');
    expect(result?.issueId).toBe('recABC');
    expect(result?.createdDate).toEqual(new Date('2024-06-15T08:30:00.000Z'));
    expect(result?.authoredBy).toBe('usrDEF');
  });

  // ── Assignee column ────────────────────────────────────────────────────────

  it('parses an Assignee change with explicit old/new classes', () => {
    const result = parser.parse(
      makeItem({ diffRowHtml: ASSIGNEE_HTML_WITH_CLASSES }),
    );

    expect(result).not.toBeNull();
    expect(result?.columnType).toBe('Assignee');
    expect(result?.oldValue).toBe('Alice');
    expect(result?.newValue).toBe('Bob');
  });

  it('parses an Assignee change positionally (no explicit classes)', () => {
    const result = parser.parse(
      makeItem({ diffRowHtml: ASSIGNEE_HTML_POSITIONAL }),
    );

    expect(result?.columnType).toBe('Assignee');
    expect(result?.oldValue).toBe('Carol');
    expect(result?.newValue).toBe('Dave');
  });

  it('handles "Assigned to" as a synonym for Assignee', () => {
    const html = ASSIGNEE_HTML_WITH_CLASSES.replace('>Assignee<', '>Assigned to<');
    const result = parser.parse(makeItem({ diffRowHtml: html }));
    expect(result?.columnType).toBe('Assignee');
  });
});

import { describe, expect, it } from 'vitest';
import {
  type ActivityItem,
  nameOf,
  toneOf,
  verdictOf,
  viewOf,
  visibleRows,
} from './activity-model.ts';
import { PROBLEM_MS, problemsOf } from './problems-model.ts';

const NOW = Date.UTC(2026, 10, 19, 18, 0);
const item = (over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: 'a',
  at: NOW - 60_000,
  deviceId: 'd',
  deviceName: 'Front desk',
  passId: 'p1',
  title: 'Maya Okafor',
  outcome: 'ok',
  direction: 'in',
  scanId: 's1',
  reason: null,
  staff: null,
  method: 'wedge',
  undoable: false,
  groupSize: null,
  ...over,
});

describe('activity rows', () => {
  it('names the person, a group by its anchor, and an unknown code', () => {
    expect(nameOf(item())).toBe('Maya Okafor');
    expect(nameOf(item({ title: 'Kwame Okafor', groupSize: 2 }))).toBe('Kwame Okafor + 1');
    expect(nameOf(item({ title: null, passId: null }))).toBe('Unknown code');
  });

  it('says what happened, with the reason from the one copy table', () => {
    expect(verdictOf(item())).toBe('Checked in');
    expect(verdictOf(item({ direction: 'out' }))).toBe('Checked out');
    expect(verdictOf(item({ outcome: 'undone' }))).toBe('Undone');
    expect(verdictOf(item({ outcome: 'refused', reason: 'voided' }))).toBe('Voided');
    expect(verdictOf(item({ outcome: 'refused', reason: null }))).toBe('Not accepted');
    expect(toneOf(item({ outcome: 'heads_up', reason: 'capacity_full' }))).toBe('hu');
  });

  it('marks a row undoable only with a scan to undo', () => {
    expect(viewOf(item({ undoable: true })).undoable).toBe(true);
    expect(viewOf(item({ undoable: true, scanId: null })).undoable).toBe(false);
    expect(viewOf(item({ method: 'manual' })).byName).toBe(true);
  });
});

describe('a list being read', () => {
  const rows = [item({ id: 'c' }), item({ id: 'b' }), item({ id: 'a' })];
  it('shows everything when nobody is reading', () => {
    expect(visibleRows(rows, new Set(['a', 'b']), false)).toEqual({ rows, queued: 0 });
  });
  it('queues the new ones and keeps the shown ones where they are', () => {
    const { rows: shown, queued } = visibleRows(rows, new Set(['a', 'b']), true);
    expect(shown.map((r) => r.id)).toEqual(['b', 'a']);
    expect(queued).toBe(1);
  });
  it('still updates a shown row in place (an undo strikes it through)', () => {
    const undone = [item({ id: 'a', outcome: 'undone' })];
    expect(visibleRows(undone, new Set(['a']), true).rows[0]?.outcome).toBe('undone');
  });
  it('shows the first page at once', () => {
    expect(visibleRows(rows, new Set(), true).queued).toBe(0);
  });
});

describe('problems', () => {
  const refused = item({ id: 'r', outcome: 'refused', reason: 'voided', at: NOW - 5 * 60_000 });
  it('lists refusals and holds from the last 15 minutes', () => {
    const old = item({ id: 'old', outcome: 'refused', at: NOW - PROBLEM_MS - 1 });
    const hold = item({ id: 'h', outcome: 'heads_up', reason: 'capacity_full', passId: 'p2' });
    const { open } = problemsOf([item({ passId: 'p9' }), refused, hold, old], NOW, new Map());
    expect(open.map((p) => p.item.id)).toEqual(['r', 'h']);
  });
  it('an unknown code can only be seen, not let in', () => {
    const unknown = item({ id: 'u', outcome: 'refused', passId: null, title: null, scanId: null });
    expect(problemsOf([unknown], NOW, new Map()).open[0]?.canLetIn).toBe(false);
    expect(problemsOf([refused], NOW, new Map()).open[0]?.canLetIn).toBe(true);
  });
  it('is resolved when the same pass was let in afterwards, naming who', () => {
    const letIn = item({ id: 'ok', passId: 'p1', at: NOW - 60_000, staff: 'Ana R.' });
    const { open, resolved } = problemsOf([letIn, refused], NOW, new Map());
    expect(open).toEqual([]);
    expect(resolved).toEqual([{ item: refused, by: 'Ana R.', how: 'let_in' }]);
  });
  it('keeps a settled problem for the day, even past 15 minutes', () => {
    const old = item({ id: 'old', outcome: 'refused', passId: null, at: NOW - 3_600_000 });
    const settled = new Map([['old', { by: 'Theo B.', how: 'seen' as const }]]);
    expect(problemsOf([old], NOW, settled).resolved).toEqual([
      { item: old, by: 'Theo B.', how: 'seen' },
    ]);
  });
});

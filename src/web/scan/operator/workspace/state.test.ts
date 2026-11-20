import { describe, expect, it } from 'vitest';
import type { ScanCounts } from '../../../../shared/contracts/scan.ts';
import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { hintsOf } from './hints.ts';
import { inNowOf, sessionChip } from './session-state.ts';

const counts = (over: Partial<ScanCounts> = {}): ScanCounts => ({
  today: 184,
  event: null,
  asOf: 0,
  configRev: 1,
  ...over,
});
const session = (over: Record<string, unknown> = {}) =>
  ({
    state: 'ready',
    workspace: null,
    scanner: null,
    event: null,
    templates: [],
    ...over,
  }) as unknown as ScanSession;

describe('in now', () => {
  it('counts a zone first, then the event, and nothing for a visits-only session', () => {
    expect(inNowOf(counts({ place: { name: 'Gym', inNow: 42, capacity: 60 } }))).toEqual({
      count: 42,
      capacity: 60,
      ratio: 0.7,
    });
    expect(
      inNowOf(counts({ event: { arrived: 9, inside: 5, expected: 9, capacity: null } })),
    ).toEqual({
      count: 5,
      capacity: null,
      ratio: null,
    });
    expect(inNowOf(counts())).toBeNull();
  });
  it('a full place reads as full, never past it', () => {
    expect(inNowOf(counts({ place: { name: 'Pool', inNow: 14, capacity: 12 } }))?.ratio).toBe(1);
  });
});

describe('the session chip', () => {
  const window = (open: boolean, closesAt: number | null, opensAt: number | null) => ({
    session: { timeZone: 'UTC', window: { open, by: 'hours', opensAt, closesAt } },
  });
  it('says when an open session closes', () => {
    const chip = sessionChip(
      session({ workspace: window(true, Date.UTC(2026, 10, 19, 22), null) }),
    );
    expect(chip).toMatchObject({ open: true });
    expect(chip.text).toMatch(/^Open until 10:00/);
  });
  it('says when a closed one opens', () => {
    const chip = sessionChip(
      session({ state: 'closed', workspace: window(false, null, Date.UTC(2026, 10, 21, 9)) }),
    );
    expect(chip).toMatchObject({ open: false, text: 'Closed today' });
    expect(chip.sub).toMatch(/^Opens Sat 9:00/);
  });
});

describe('status bar hints', () => {
  it('shows the keys for what is open', () => {
    expect(
      hintsOf({ searching: true, record: false, undoable: true, views: 2 }).map((h) => h.label),
    ).toEqual(['Move', 'Open', 'Clear']);
    const open = hintsOf({ searching: false, record: true, undoable: true, views: 2 }).map(
      (h) => h.label,
    );
    expect(open).toEqual(['Search', 'Primary', 'Close', 'Undo last', 'Lists', 'Shortcuts']);
    expect(
      hintsOf({ searching: false, record: false, undoable: false, views: 1 }).map((h) => h.label),
    ).toEqual(['Search', 'Shortcuts']);
  });
});

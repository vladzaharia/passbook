import { describe, expect, it } from 'vitest';
import {
  nextDrafts,
  reviewAmount,
  settledDrafts,
  shownDraft,
  withoutReplacedReady,
} from './customer-draft.ts';

const view = { band: { headline: 'To pay', sub: null }, figure: '$12.00' } as never;
const say = (ref: string, at: number, scannerId = 's1', readyAt = at - 100) => ({
  ref,
  at,
  scannerId,
  readyAt,
  customer: view,
});

describe('customer draft', () => {
  it('reads the words and the figure from the view', () => {
    expect(reviewAmount(view)).toEqual({ label: 'To pay', value: '$12.00' });
    expect(reviewAmount({ band: { headline: 'Hello', sub: null } } as never)).toBeUndefined();
  });

  it('keeps one draft per ref, the latest at wins, and a cancel drops only its own', () => {
    const a = nextDrafts(new Map(), say('r', 10), 10);
    const both = nextDrafts(a, say('s', 11), 11);
    expect([...both.keys()]).toEqual(['r', 's']);
    expect(nextDrafts(both, say('r', 5), 12).get('r')?.at).toBe(10);
    expect([...nextDrafts(both, { ref: 'r', at: 12, cancelled: true }, 12).keys()]).toEqual(['s']);
  });

  it('prunes a draft past its hold', () => {
    const a = nextDrafts(new Map(), say('r', 1000), 1000);
    expect(nextDrafts(a, say('s', 21_001), 21_001).has('r')).toBe(false);
  });

  it('shows the newest fresh draft over its card, an idle screen or an older result', () => {
    const a = nextDrafts(new Map(), say('r', 1000, 's1', 900), 1000);
    expect(shownDraft(a, { id: 'r', at: 900, kind: 'ready' }, 1500)?.ref).toBe('r');
    expect(shownDraft(a, undefined, 1500)?.ref).toBe('r');
    expect(shownDraft(a, { id: 'x', at: 800, kind: 'ok' }, 1500)?.ref).toBe('r');
    expect(shownDraft(a, { id: 'r', at: 900, kind: 'ready' }, 1000 + 20_000)).toBeNull();
  });

  it('never shows over a newer result, even for a draft that is newer than it', () => {
    // The draft was sent after the receipt landed, but for a read that began before it.
    const a = nextDrafts(new Map(), say('r', 2000, 's1', 1000), 2000);
    expect(shownDraft(a, { id: 'ok', at: 1500, kind: 'ok' }, 2100)).toBeNull();
    // Nor over another desk's ready card.
    expect(shownDraft(a, { id: 'other', at: 500, kind: 'ready' }, 2100)).toBeNull();
  });

  it("a later row from the desk ends its draft: a result, or the next read's ready card", () => {
    const a = nextDrafts(nextDrafts(new Map(), say('r', 1000), 1000), say('t', 1000, 's2'), 1000);
    const row = (id: string, scannerId: string, at: number) => ({ id, scannerId, at });
    expect([...settledDrafts(a, [row('ok', 's1', 1500)]).keys()]).toEqual(['t']);
    expect([...settledDrafts(a, [row('r2', 's1', 1500)]).keys()]).toEqual(['t']);
    // Its own ready card does not end it, nor does an older row.
    expect(settledDrafts(a, [row('r', 's1', 900), row('old', 's1', 800)])).toBe(a);
  });

  it('drops a ready card that a later result of the same scanner replaced', () => {
    const row = (id: string, kind: 'ready' | 'ok', at: number, scannerId = 's1') =>
      ({ id, kind, at, scannerId }) as never;
    const rows = [
      row('r1', 'ready', 1),
      row('ok', 'ok', 2),
      row('r2', 'ready', 3),
      row('r3', 'ready', 1, 's2'),
    ];
    expect(withoutReplacedReady(rows).map((r) => r.id)).toEqual(['ok', 'r2', 'r3']);
  });
});

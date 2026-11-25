import { describe, expect, it } from 'vitest';
import {
  nextDrafts,
  reviewAmount,
  settledDrafts,
  shownDraft,
  withoutReplacedReady,
} from './customer-draft.ts';

const view = { band: { headline: 'To pay', sub: null }, figure: '$12.00' } as never;
const say = (ref: string, at: number, scannerId = 's1') => ({
  ref,
  at,
  scannerId,
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

  it('shows the newest fresh draft, for its card or over anything older', () => {
    const a = nextDrafts(new Map(), say('r', 1000), 1000);
    expect(shownDraft(a, { id: 'r', at: 900 }, 1500)?.ref).toBe('r');
    expect(shownDraft(a, undefined, 1500)?.ref).toBe('r');
    expect(shownDraft(a, { id: 'x', at: 800 }, 1500)?.ref).toBe('r');
    expect(shownDraft(a, { id: 'x', at: 1200 }, 1500)).toBeNull();
    expect(shownDraft(a, { id: 'r', at: 900 }, 1000 + 20_000)).toBeNull();
  });

  it("a desk's result ends its drafts, and no other desk's", () => {
    const a = nextDrafts(nextDrafts(new Map(), say('r', 1000), 1000), say('t', 1000, 's2'), 1000);
    const after = settledDrafts(a, [{ kind: 'ok', scannerId: 's1', at: 1500 }]);
    expect([...after.keys()]).toEqual(['t']);
    expect(settledDrafts(a, [{ kind: 'ready', scannerId: 's1', at: 1500 }])).toBe(a);
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

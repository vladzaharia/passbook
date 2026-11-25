import { describe, expect, it } from 'vitest';
import { liveDraft, nextDraft, reviewAmount, withoutReplacedReady } from './customer-draft.ts';

const view = { band: { headline: 'To pay', sub: null }, figure: '$12.00' } as never;

describe('customer draft', () => {
  it('reads the words and the figure from the view', () => {
    expect(reviewAmount(view)).toEqual({ label: 'To pay', value: '$12.00' });
    expect(reviewAmount({ band: { headline: 'Hello', sub: null } } as never)).toBeUndefined();
  });
  it('the latest at wins and a cancel for the same ref clears', () => {
    const a = nextDraft(null, { ref: 'r', at: 10, customer: view });
    expect(nextDraft(a, { ref: 'r', at: 5, customer: view })).toBe(a);
    expect(nextDraft(a, { ref: 'r', at: 11, cancelled: true })).toBeNull();
    expect(nextDraft(a, { ref: 'other', at: 11, cancelled: true })).toBe(a);
  });
  it('ignores a draft for another ref or older than 60 s', () => {
    const a = nextDraft(null, { ref: 'r', at: 1000, customer: view });
    expect(liveDraft(a, 'r', 1000 + 59_999)).toBe(a);
    expect(liveDraft(a, 'r', 1000 + 60_000)).toBeNull();
    expect(liveDraft(a, 'x', 1000)).toBeNull();
    expect(liveDraft(a, undefined, 1000)).toBeNull();
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

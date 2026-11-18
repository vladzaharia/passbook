import { describe, expect, it } from 'vitest';
import { FAKE_NOW, GYM_KEY, insideRow, rows } from './inside-fake.test-support.ts';
import { initialInside, insideReducer, mergePlaces, sortLongest } from './inside-model.ts';
import type { InsideList, InsidePlace } from './inside-types.ts';

const place = (over: Partial<InsidePlace> = {}): InsidePlace => ({
  place: GYM_KEY,
  name: 'Gym',
  inNow: 4,
  capacity: 60,
  rev: 5,
  parent: null,
  ...over,
});
const list = (over: Partial<InsideList> = {}): InsideList => ({
  places: [place()],
  items: rows(4),
  total: 4,
  nextCursor: null,
  asOf: FAKE_NOW,
  ...over,
});
const loaded = (l = list()) =>
  insideReducer(initialInside(), { t: 'loaded', list: l, append: false });

describe("the Who's in reducer", () => {
  it('starts loading, with nothing', () => {
    expect(initialInside()).toMatchObject({ loading: true, rows: [], places: [] });
  });
  it('a load sorts longest first', () => {
    const shuffled = [insideRow(0), insideRow(3), insideRow(1)];
    const s = loaded(list({ items: shuffled, total: 3 }));
    expect(s.rows.map((r) => r.since)).toEqual(
      [...s.rows.map((r) => r.since)].sort((a, b) => a - b),
    );
    expect(s.rows[0]?.passId).toBe(insideRow(3).passId);
    expect(s.loading).toBe(false);
  });
  it('a tie in time keeps a stable order', () => {
    const a = insideRow(1, { since: 100 });
    const b = insideRow(2, { since: 100 });
    expect(sortLongest([b, a]).map((r) => r.passId)).toEqual(
      sortLongest([a, b]).map((r) => r.passId),
    );
  });
  it('a page appends without repeating a row', () => {
    const first = loaded(list({ items: rows(3), total: 5, nextCursor: '3' }));
    const next = insideReducer(first, {
      t: 'loaded',
      list: list({ items: rows(5).slice(0, 3), total: 5 }),
      append: true,
    });
    expect(next.rows).toHaveLength(5);
    expect(next.next).toBeNull();
  });
  it('a failure keeps the last list and flags the error; a query clears the flag', () => {
    const failed = insideReducer(loaded(), { t: 'failed' });
    expect(failed).toMatchObject({ error: true, loading: false });
    expect(failed.rows).toHaveLength(4);
    expect(insideReducer(failed, { t: 'query', q: 'le' })).toMatchObject({ error: false, q: 'le' });
  });
  it('marking out drops the row and the count at once', () => {
    const s = loaded();
    const gone = s.rows[0];
    if (!gone) throw new Error('row');
    const after = insideReducer(s, { t: 'removed', passId: gone.passId });
    expect(after.rows).toHaveLength(3);
    expect(after.total).toBe(3);
    expect(after.places[0]?.inNow).toBe(3);
    expect(insideReducer(after, { t: 'removed', passId: 'nobody' })).toBe(after);
  });
  it('a failed mark-out puts the row back in its place and the count up', () => {
    const s = loaded();
    const gone = s.rows[0];
    if (!gone) throw new Error('row');
    const back = insideReducer(insideReducer(s, { t: 'removed', passId: gone.passId }), {
      t: 'restored',
      row: gone,
    });
    expect(back.rows.map((r) => r.passId)).toEqual(s.rows.map((r) => r.passId));
    expect(back.places[0]?.inNow).toBe(4);
    expect(insideReducer(back, { t: 'restored', row: gone })).toBe(back);
  });
});

describe('place counts and rev', () => {
  it('a lower rev never replaces a higher one', () => {
    expect(
      mergePlaces([place({ rev: 7, inNow: 3 })], [place({ rev: 6, inNow: 9 })])[0]?.inNow,
    ).toBe(3);
    expect(
      mergePlaces([place({ rev: 7, inNow: 3 })], [place({ rev: 8, inNow: 2 })])[0]?.inNow,
    ).toBe(2);
    expect(
      mergePlaces([place({ rev: 7, inNow: 3 })], [place({ rev: 7, inNow: 3 })])[0]?.inNow,
    ).toBe(3);
  });
  it('a poll that was already in flight cannot undo a mark-out', () => {
    const s = loaded();
    const gone = s.rows[0];
    if (!gone) throw new Error('row');
    const marked = insideReducer(s, { t: 'removed', passId: gone.passId });
    const stale = insideReducer(marked, {
      t: 'loaded',
      list: list({ places: [place({ rev: 5, inNow: 4 })], items: rows(4) }),
      append: false,
    });
    expect(stale.places[0]?.inNow).toBe(3);
  });
  it('the server answer to a mark-out wins over the optimistic count', () => {
    const s = loaded();
    const gone = s.rows[0];
    if (!gone) throw new Error('row');
    const marked = insideReducer(s, { t: 'removed', passId: gone.passId });
    const done = insideReducer(marked, {
      t: 'rev',
      place: { place: GYM_KEY, name: 'Gym', inNow: 2, capacity: 60, rev: 6 },
    });
    expect(done.places[0]).toMatchObject({ inNow: 2, rev: 6 });
    const late = insideReducer(done, {
      t: 'rev',
      place: { place: GYM_KEY, name: 'Gym', inNow: 9, capacity: 60, rev: 5 },
    });
    expect(late.places[0]?.inNow).toBe(2);
  });
});

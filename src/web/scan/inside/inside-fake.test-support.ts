/** An in-memory Who's in for tests and the visual gallery. It keeps WP-G's shapes. */
import { fixtureCounts, fixtureOutcome } from '../machine/fixture-data.test-support.ts';
import {
  type InsideApiPort,
  type InsideList,
  type InsidePlace,
  type InsideQuery,
  type InsideRow,
  type MarkOutRequest,
  MarkOutResultSchema,
} from './inside-types.ts';

export const FAKE_NOW = Date.UTC(2026, 10, 18, 11, 0, 0);
const MIN = 60_000;
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const GYM_KEY = 'zone:gym';
export const POOL_KEY = 'zone:pool';

export function insideRow(n: number, over: Partial<InsideRow> = {}): InsideRow {
  const names = ['Maya Okafor', 'Leo Park', 'Ana Ruiz', 'Sam Kim', 'Ira Novak', 'Tess Lund'];
  return {
    passId: id(n),
    holder: names[n % names.length] ?? `Person ${n}`,
    photoUrl: null,
    plan: n % 3 === 0 ? 'Visitor' : 'Staff',
    place: GYM_KEY,
    since: FAKE_NOW - (n + 1) * 20 * MIN,
    via: 'Front desk',
    flags: [],
    zone: { name: 'Floor 3', parent: 'HQ' },
    dueAt: FAKE_NOW + 4 * 60 * MIN,
    host: null,
    ...over,
  };
}

export const rows = (count: number): InsideRow[] =>
  Array.from({ length: count }, (_, n) => insideRow(n)).sort((a, b) => a.since - b.since);

export interface FakeInside extends InsideApiPort {
  calls: { inside: InsideQuery[]; markOut: MarkOutRequest[]; undo: string[] };
  rows: InsideRow[];
  fail: { inside: Error | null; markOut: Error | null };
  rev: number;
}

export function fakeInsideApi(
  start: InsideRow[] = rows(4),
  places: Partial<InsidePlace>[] = [],
): FakeInside {
  const fake: FakeInside = {
    calls: { inside: [], markOut: [], undo: [] },
    rows: [...start],
    fail: { inside: null, markOut: null },
    rev: 1,
    async inside(query) {
      fake.calls.inside.push(query);
      if (fake.fail.inside) throw fake.fail.inside;
      const q = query.q?.toLowerCase();
      const matching = fake.rows
        .filter((r) => !query.place || r.place === query.place)
        .filter((r) => !q || (r.holder ?? '').toLowerCase().includes(q))
        .sort((a, b) => a.since - b.since);
      const from = query.cursor ? Number(query.cursor) : 0;
      const limit = query.limit ?? 50;
      const page = matching.slice(from, from + limit);
      const list: InsideList = {
        places: placesOf(fake, places),
        items: page,
        total: matching.length,
        nextCursor: from + limit < matching.length ? String(from + limit) : null,
        asOf: FAKE_NOW,
      };
      return list;
    },
    async markOut(body) {
      fake.calls.markOut.push(body);
      if (fake.fail.markOut) throw fake.fail.markOut;
      fake.rows = fake.rows.filter((r) => r.passId !== body.passId);
      fake.rev += 1;
      const place = placesOf(fake, places)[0];
      return MarkOutResultSchema.parse(
        fixtureOutcome('ok', null, {
          scanId: `scan-${fake.calls.markOut.length}`,
          action: { id: 'mark_out', label: 'Mark as out', kind: 'check_in' },
          counts: fixtureCounts({
            place: place && { name: place.name, inNow: place.inNow, capacity: place.capacity },
          }),
          undoUntil: FAKE_NOW + 10 * MIN,
        }),
      );
    },
    async undoMarkOut(scanId) {
      fake.calls.undo.push(scanId);
      return {};
    },
  };
  return fake;
}

function placesOf(fake: FakeInside, over: Partial<InsidePlace>[]): InsidePlace[] {
  const gym = fake.rows.filter((r) => r.place === GYM_KEY).length;
  const base: InsidePlace[] = [
    { place: GYM_KEY, name: 'Gym', inNow: gym, capacity: 60, rev: fake.rev },
  ];
  return base.map((p, i) => ({ ...p, ...(over[i] ?? {}) }));
}

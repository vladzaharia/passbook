import { beforeAll, describe, expect, it } from 'vitest';
import { makePass } from '../../../../../test/helpers/index.ts';
import type { ScanZone } from '../../../../shared/contracts/scan-access.ts';
import { all, run } from '../../../platform/db.ts';
import { scanningSessionsFixture } from '../scanning-sessions-test-fixtures.ts';
import { insidePage } from './inside.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

let seq = 0;
async function zone(extra: Record<string, unknown> = {}): Promise<ScanZone> {
  const key = `occ${(seq++).toString(36)}`;
  const res = await fixture.call('POST', '/scan-zones', {
    orgId: fixture.kit.org.id,
    key,
    name: `Occ ${key}`,
    ...extra,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ScanZone;
}

/** Inside rows at each zone (as an entry would write them), live until `due`. */
async function inside(zones: ScanZone[], due: number | null = null) {
  const { kit } = fixture;
  const pass = await makePass(kit.fx, { orgId: kit.org.id, template: kit.template });
  const now = kit.clock.now();
  for (const z of zones)
    await run(
      kit.env.DB,
      `INSERT INTO scan_presence (pass_id, org_id, scope, state, tracking, entered_at, first_at, last_entry_at,
         last_scan_id, due_at) VALUES (?, ?, ?, 'in', 1, ?, ?, ?, 'seed', ?)`,
      [pass.id, kit.org.id, `zone:${z.id}`, now, now, now, due],
    );
  return pass.id;
}

const dues = async (passId: string) =>
  (
    await all<{ due_at: number | null }>(
      fixture.kit.env.DB,
      'SELECT due_at FROM scan_presence WHERE pass_id = ? ORDER BY scope',
      [passId],
    )
  ).map((r) => r.due_at);

describe('a zone change taps its subtree out', () => {
  const tracked = { occupancy: 'track', maxStayMinutes: 60 };

  it('Track off sets every inside row of the zone and below due now', async () => {
    const gym = await zone({ ...tracked, timeZone: 'UTC' });
    const pool = await zone({ ...tracked, parentId: gym.id });
    const p = await inside([gym, pool], fixture.kit.clock.now() + 3_600_000);
    const res = await fixture.call('PATCH', `/scan-zones/${pool.id}`, {
      occupancy: 'off',
      maxStayMinutes: null,
    });
    expect(res.status).toBe(200);
    const now = fixture.kit.clock.now();
    // Gym stays; the pool row falls due now and reads as out.
    expect((await dues(p)).sort()).toEqual([now, now + 3_600_000].sort());
  });

  it('archive taps the zone and everything below it out; a row already due keeps its time', async () => {
    const gym = await zone({ ...tracked, timeZone: 'UTC' });
    const pool = await zone({ ...tracked, parentId: gym.id });
    const p = await inside([gym, pool]);
    const earlier = fixture.kit.clock.now() - 1_000;
    const q = await inside([pool], earlier);
    const res = await fixture.call('POST', `/scan-zones/${gym.id}/archive`, {});
    expect(res.status).toBe(200);
    const now = fixture.kit.clock.now();
    expect(await dues(p)).toEqual([now, now]);
    expect(await dues(q)).toEqual([earlier]);
  });

  it('a parent move taps the moved zone and everything below it out, not its old parent', async () => {
    const gym = await zone({ ...tracked, timeZone: 'UTC' });
    const club = await zone({ ...tracked, timeZone: 'UTC' });
    const pool = await zone({ ...tracked, parentId: gym.id });
    const lane = await zone({ ...tracked, parentId: pool.id });
    const p = await inside([gym, pool, lane]);
    const res = await fixture.call('PATCH', `/scan-zones/${pool.id}`, { parentId: club.id });
    expect(res.status).toBe(200);
    const due = await all<{ scope: string; due_at: number | null }>(
      fixture.kit.env.DB,
      'SELECT scope, due_at FROM scan_presence WHERE pass_id = ?',
      [p],
    );
    const at = Object.fromEntries(due.map((r) => [r.scope, r.due_at]));
    const now = fixture.kit.clock.now();
    expect([at[`zone:${gym.id}`], at[`zone:${pool.id}`], at[`zone:${lane.id}`]]).toEqual([
      null,
      now,
      now,
    ]);
  });

  it('a rename changes nothing', async () => {
    const gym = await zone({ ...tracked, timeZone: 'UTC' });
    const p = await inside([gym]);
    expect((await fixture.call('PATCH', `/scan-zones/${gym.id}`, { name: 'Renamed' })).status).toBe(
      200,
    );
    expect(await dues(p)).toEqual([null]);
  });
});

describe("who's inside", () => {
  it('lists live rows of the mode, oldest first, paged, with the total', async () => {
    const { kit } = fixture;
    const pool = await zone({ occupancy: 'track' });
    const ids = [await inside([pool]), await inside([pool]), await inside([pool])];
    await inside([pool], kit.clock.now() - 1);
    const q = { orgId: kit.org.id, mode: 'live', place: `zone:${pool.id}`, now: kit.clock.now() };
    const first = await insidePage(kit.env.DB, { ...q, limit: 2 });
    expect(first.total).toBe(3);
    expect(first.items.map((r) => r.passId)).toEqual([...ids].sort().slice(0, 2));
    const rest = await insidePage(kit.env.DB, { ...q, limit: 2, cursor: first.nextCursor });
    expect(rest).toMatchObject({ total: 3, nextCursor: null });
    expect(rest.items.map((r) => r.passId)).toEqual([...ids].sort().slice(2));
    expect((await insidePage(kit.env.DB, { ...q, mode: 'test' })).total).toBe(0);
  });
});

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { ACCESS, accessTemplate, gateRow } from './access-test-fixtures.ts';
import { act, CHECK_IN, HOUR, kit, MINUTE, out, setupActionFixture } from './act-test-fixtures.ts';
import { placeRow, scanAt, trackedZone, zoneDoor } from './occupancy-scan-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const DISPLAY = {
  v: 1,
  holder: '{{inputs.memberName}}',
  header: { chips: [{ id: 'c_plan', text: '{{access.plan}}', tone: 'violet' }] },
  panels: [
    {
      id: 'p_visits',
      title: 'Visits',
      rows: [
        {
          id: 'r_v',
          type: 'columns',
          items: [
            { id: 'i_month', label: 'Month', value: 'visits {{history.visits.month}}' },
            { id: 'i_last', label: 'Last', value: 'last {{history.lastVisit.at}}' },
          ],
        },
      ],
    },
  ],
} as const;

describe('review: visits at a tracked zone', () => {
  it('an exit is not a visit: one entry and one exit show one visit, the entry last', async () => {
    const tpl = await kit.scanTemplate('Access card visits', {
      actions: [CHECK_IN],
      access: ACCESS,
      display: DISPLAY as never,
    });
    const gym = await trackedZone();
    const desk = await zoneDoor(tpl, [gym], 'both');
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const lastOf = (o: { display?: unknown }) =>
      /last ([^"\\]*)/.exec(JSON.stringify(o.display))?.[1] ?? null;
    const entry = await scanAt(desk, pass);
    const lastAtEntry = lastOf(entry);
    expect(lastAtEntry).not.toBeNull();
    kit.clock.advance(5 * MINUTE);
    const left = await scanAt(desk, pass);
    expect(left.occupancy?.direction).toBe('out');
    expect(JSON.stringify(left.display)).toContain('visits 1');
    expect(lastOf(left)).toBe(lastAtEntry);
    expect(await first(kit.env.DB, 'SELECT visit FROM scans WHERE id = ?', [left.scanId])).toEqual({
      visit: 0,
    });
    kit.clock.advance(5 * MINUTE);
    const back = await scanAt(desk, pass);
    expect(JSON.stringify(back.display)).toContain('visits 1');
    expect(lastOf(back)).toBe(lastAtEntry);
  });
});

const WAIT = { ...ACCESS, rules: { visitGapMinutes: 120, reentryMinutes: 10 } };

describe('review: step 15 order at a place', () => {
  it('answers a re-tap three minutes later at a tap-out zone as Already in, not the wait', async () => {
    const tpl = await accessTemplate(WAIT);
    const gym = await trackedZone({ occupancy: 'enforce' });
    const way = await zoneDoor(tpl, [gym]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    expect((await scanAt(way, pass)).kind).toBe('ok');
    kit.clock.advance(3 * MINUTE);
    expect(await scanAt(way, pass)).toMatchObject({ kind: 'heads_up', reason: 'still_inside' });
  });

  it('answers a guest with no visits left, outside the parent, as not tapped in', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce' });
    const pool = await trackedZone({ occupancy: 'track', parentId: gym });
    const gymIn = await zoneDoor(tpl, [gym]);
    const gymOut = await zoneDoor(tpl, [gym], 'out');
    const poolIn = await zoneDoor(tpl, [pool]);
    const pass = await kit.scanPass(tpl, { plan: 'guest', visits: 1 });
    await scanAt(gymIn, pass);
    kit.clock.advance(10 * MINUTE);
    await scanAt(gymOut, pass);
    kit.clock.advance(3 * HOUR);
    expect(await scanAt(poolIn, pass)).toMatchObject({ kind: 'heads_up', reason: 'not_inside' });
    expect(await scanAt(gymIn, pass)).toMatchObject({
      kind: 'refused',
      reason: 'guest_visits_used',
    });
  });
});

describe('review: a track-only repeat and an implied parent', () => {
  async function setup() {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'track', capacity: 1 });
    const pool = await trackedZone({ occupancy: 'track', parentId: gym });
    return {
      tpl,
      gym,
      pool,
      gymIn: await zoneDoor(tpl, [gym]),
      poolIn: await zoneDoor(tpl, [pool]),
      pass: await kit.scanPass(tpl, { plan: 'gold' }),
      other: await kit.scanPass(tpl, { plan: 'gold' }),
    };
  }
  const liveIn = async (zoneId: string) =>
    (
      await first<{ n: number }>(
        kit.env.DB,
        "SELECT count(*) AS n FROM scan_presence WHERE scope = ? AND state = 'in' AND (due_at IS NULL OR due_at > ?)",
        [`zone:${zoneId}`, kit.clock.now()],
      )
    )?.n ?? 0;

  it('holds the parent full when its row is past due', async () => {
    const s = await setup();
    expect((await scanAt(s.poolIn, s.pass)).kind).toBe('ok');
    await run(kit.env.DB, 'UPDATE scan_presence SET due_at = ? WHERE pass_id = ? AND scope = ?', [
      kit.clock.now() - 1,
      s.pass.id,
      `zone:${s.gym}`,
    ]);
    kit.clock.advance(MINUTE);
    expect((await scanAt(s.gymIn, s.other)).kind).toBe('ok');
    kit.clock.advance(5 * MINUTE);
    expect(await scanAt(s.poolIn, s.pass)).toMatchObject({ reason: 'capacity_full' });
    expect(await liveIn(s.gym)).toBe(1);
  });

  it('holds the parent full when it started tracking after the entry', async () => {
    const s = await setup();
    await run(
      kit.env.DB,
      "UPDATE scan_zones SET occupancy = 'off', capacity = NULL, max_stay_minutes = NULL WHERE id = ?",
      [s.gym],
    );
    expect((await scanAt(s.poolIn, s.pass)).kind).toBe('ok');
    expect(await placeRow(s.pass.id, s.gym)).toBeNull();
    await run(
      kit.env.DB,
      "UPDATE scan_zones SET occupancy = 'track', capacity = 1, max_stay_minutes = 720 WHERE id = ?",
      [s.gym],
    );
    expect((await scanAt(s.gymIn, s.other)).kind).toBe('ok');
    kit.clock.advance(5 * MINUTE);
    expect(await scanAt(s.poolIn, s.pass)).toMatchObject({ reason: 'capacity_full' });
    expect(await liveIn(s.gym)).toBe(1);
  });
});

describe('review: an override is an entry', () => {
  it('lets a held entry through on a Both door even when the pass now reads inside', async () => {
    const tpl = await accessTemplate(WAIT);
    const gym = await trackedZone({ occupancy: 'track' });
    const way = await zoneDoor(tpl, [gym]);
    const exit = await zoneDoor(tpl, [gym], 'out');
    const desk = await zoneDoor(tpl, [gym], 'both');
    const boss = await kit.staff('manager', 'Boss');
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    await scanAt(way, pass);
    kit.clock.advance(MINUTE);
    await scanAt(exit, pass);
    kit.clock.advance(3 * MINUTE);
    const held = await scanAt(desk, pass);
    expect(held).toMatchObject({ kind: 'heads_up', reason: 'cooldown' });
    // Another door let them in meanwhile: Auto alone would now tap them out.
    await run(
      kit.env.DB,
      "UPDATE scan_presence SET state = 'in', entered_at = ? WHERE pass_id = ? AND scope = ?",
      [kit.clock.now(), pass.id, `zone:${gym}`],
    );
    const granted = await out(
      await act(desk.headers, codeOf(pass), {
        actionId: 'check_in',
        overrideOf: held.scanId,
        approval: { staffId: boss.id, pin: boss.pin },
      }),
    );
    expect(granted).toMatchObject({ kind: 'ok', occupancy: { direction: 'in', state: 'in' } });
    expect(await placeRow(pass.id, gym)).toMatchObject({ state: 'in' });
    expect(await gateRow(pass.id)).toMatchObject({ count: 1 });
  });
});

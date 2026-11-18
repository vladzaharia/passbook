import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import type { AccessManifest } from '../../../passkit/types.ts';
import {
  ACCESS,
  accessTemplate,
  gateRow,
  grantOf,
  makeDoor,
  makeZone,
  scanRows,
} from './access-test-fixtures.ts';
import { act, HOUR, kit, MINUTE, out, setupActionFixture } from './act-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const NIGHT = TEST_NOW + 8 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

async function door(access: AccessManifest = ACCESS, zones: string[] = ['gym']) {
  const tpl = await accessTemplate(access);
  const ids = await Promise.all(
    zones.map((key) => makeZone(`${key}-${Math.random().toString(36).slice(2, 8)}`)),
  );
  return { tpl, ids, ...(await makeDoor([tpl], ids)) };
}

describe('access: the order of steps 10-16', () => {
  it('grants a member: ok, with the plan, the zone and the first visit', async () => {
    const d = await door();
    const pass = await kit.scanPass(d.tpl, { plan: 'gold' });
    const o = await grantOf(d.headers, pass);
    expect(o).toMatchObject({
      kind: 'ok',
      reason: null,
      access: {
        plan: { id: 'gold', label: '24/7 Gold', kind: 'always' },
        zone: { id: d.ids[0] },
        closesAt: null,
        visits: { used: 1, limit: null },
        visit: true,
        timeZone: 'UTC',
      },
    });
    expect(await scanRows(pass.id)).toMatchObject([
      { outcome: 'ok', zone_id: d.ids[0], visit: 1, access_plan: 'gold' },
    ]);
  });

  it('refuses a suspended pass first, before it is outside hours or not yet valid', async () => {
    const d = await door();
    kit.clock.set(NIGHT);
    const pass = await kit.scanPass(d.tpl, {
      plan: 'off_peak',
      status: 'Suspended',
      validFrom: iso(NIGHT + HOUR),
    });
    const o = await grantOf(d.headers, pass);
    expect(o).toMatchObject({
      kind: 'refused',
      reason: 'suspended',
      access: { plan: { id: 'off_peak' } },
    });
    expect(await gateRow(pass.id)).toBeNull();
  });

  it('refuses a pass that has not started, with when it opens', async () => {
    const d = await door();
    const from = TEST_NOW + 2 * HOUR;
    const pass = await kit.scanPass(d.tpl, { plan: 'gold', validFrom: iso(from) });
    const o = await grantOf(d.headers, pass);
    expect(o).toMatchObject({ kind: 'refused', reason: 'not_yet_valid', at: from });
    expect(await gateRow(pass.id)).toBeNull();
  });

  it('refuses a guest whose window ended, before zones and hours', async () => {
    const d = await door();
    const pass = await kit.scanPass(d.tpl, { plan: 'guest', validUntil: iso(TEST_NOW - MINUTE) });
    const o = await grantOf(d.headers, pass);
    expect(o).toMatchObject({ kind: 'refused', reason: 'guest_expired', at: TEST_NOW - MINUTE });
  });

  it('refuses a plan that does not open the door, naming the zone', async () => {
    const d = await door();
    const pass = await kit.scanPass(d.tpl, { plan: 'pool_only' });
    const o = await grantOf(d.headers, pass);
    expect(o).toMatchObject({
      kind: 'refused',
      reason: 'zone_not_included',
      access: { plan: { id: 'pool_only' }, zone: { id: d.ids[0] } },
    });
  });

  it('refuses outside the plan hours, with the next opening, before the gate', async () => {
    const d = await door();
    kit.clock.set(NIGHT);
    const pass = await kit.scanPass(d.tpl, { plan: 'off_peak' });
    const o = await grantOf(d.headers, pass);
    expect(o.reason).toBe('outside_hours');
    expect(o.access?.nextOpenAt).toBe(Date.UTC(2026, 5, 2, 6));
    expect(await gateRow(pass.id)).toBeNull();
  });

  it('refuses a guest whose visits are used, once a new visit would pass the limit', async () => {
    const d = await door();
    const pass = await kit.scanPass(d.tpl, { plan: 'guest', visits: 1 });
    expect((await grantOf(d.headers, pass)).kind).toBe('ok');
    kit.clock.advance(3 * HOUR);
    const o = await grantOf(d.headers, pass);
    expect(o).toMatchObject({
      kind: 'refused',
      reason: 'guest_visits_used',
      access: { visits: { used: 1, limit: 1 } },
    });
    expect(await gateRow(pass.id)).toMatchObject({ count: 1 });
    const rows = await scanRows(pass.id);
    expect(rows.map((r) => [r.outcome, r.reason, r.visit])).toEqual([
      ['ok', null, 1],
      ['refused', 'guest_visits_used', null],
    ]);
  });

  it('holds a grant inside the re-entry wait as a heads-up, and counts nothing', async () => {
    const waiting = { ...ACCESS, rules: { visitGapMinutes: 120, reentryMinutes: 10 } };
    const d = await door(waiting);
    const pass = await kit.scanPass(d.tpl, { plan: 'gold' });
    expect((await grantOf(d.headers, pass)).kind).toBe('ok');
    kit.clock.advance(4 * MINUTE);
    const o = await grantOf(d.headers, pass);
    expect(o).toMatchObject({
      kind: 'heads_up',
      reason: 'cooldown',
      cooldownRemainingMs: 6 * MINUTE,
    });
    expect(await gateRow(pass.id)).toMatchObject({ count: 1 });
    kit.clock.advance(7 * MINUTE);
    expect((await grantOf(d.headers, pass)).kind).toBe('ok');
    expect(await gateRow(pass.id)).toMatchObject({ count: 1 });
  });

  it('lets a held re-entry through when the heads-up is overridden', async () => {
    const waiting = { ...ACCESS, rules: { visitGapMinutes: 120, reentryMinutes: 10 } };
    const d = await door(waiting);
    const boss = await kit.staff('manager', 'Boss');
    const pass = await kit.scanPass(d.tpl, { plan: 'gold' });
    await grantOf(d.headers, pass);
    kit.clock.advance(2 * MINUTE);
    const held = await grantOf(d.headers, pass);
    expect(held).toMatchObject({ kind: 'heads_up', reason: 'cooldown', overridable: true });
    const through = await out(
      await act(d.headers, codeOf(pass), {
        overrideOf: held.scanId,
        approval: { staffId: boss.id, pin: boss.pin },
      }),
    );
    expect(through).toMatchObject({ kind: 'ok', access: { visit: false } });
    expect(await gateRow(pass.id)).toMatchObject({ count: 1 });
  });

  it('counts a second grant inside the gap as the same visit, and a later one as a new visit', async () => {
    const d = await door();
    const pass = await kit.scanPass(d.tpl, { plan: 'gold' });
    const first = await grantOf(d.headers, pass);
    kit.clock.advance(30 * MINUTE);
    const again = await grantOf(d.headers, pass);
    expect([first.access?.visit, again.access?.visit]).toEqual([true, false]);
    expect(again.access?.visits?.used).toBe(1);
    kit.clock.advance(3 * HOUR);
    const next = await grantOf(d.headers, pass);
    expect(next.access).toMatchObject({ visit: true, visits: { used: 2 } });
    expect((await scanRows(pass.id)).map((r) => r.visit)).toEqual([1, 0, 1]);
  });
});

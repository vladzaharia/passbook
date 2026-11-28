import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import type { AccessManifest } from '../../../passkit/types.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { waiveOf } from './access.ts';
import {
  ACCESS,
  accessTemplate,
  gateRow,
  grantOf,
  makeDoor,
  makeZone,
  scanRows,
} from './access-test-fixtures.ts';
import { act, CHECK_IN, HOUR, kit, MINUTE, out, setupActionFixture } from './act-test-fixtures.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { RACE_GATE_WRITE } from './race-tags.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const rules = (visitGapMinutes: number, reentryMinutes: number | null): AccessManifest => ({
  ...ACCESS,
  rules: { visitGapMinutes, reentryMinutes },
});
const commit = RACE_GATE_WRITE;

describe('access gate: the wait, the limit and the visit', () => {
  it('holds a second door inside the wait even when every grant is a visit (gap 0)', async () => {
    const tpl = await accessTemplate(rules(0, 10));
    const a = await makeDoor([tpl]);
    const b = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    expect((await grantOf(a.headers, pass)).kind).toBe('ok');
    kit.clock.advance(11 * MINUTE);
    const seen: { b?: ScanOutcome } = {};
    const { result } = await beforeBatch(
      kit.env,
      commit,
      async () => {
        seen.b = await grantOf(b.headers, pass);
      },
      () => grantOf(a.headers, pass),
    );
    expect(seen.b?.kind).toBe('ok');
    expect(result).toMatchObject({ kind: 'heads_up', reason: 'in_progress' });
    expect(await gateRow(pass.id)).toMatchObject({ count: 2 });
    expect((await scanRows(pass.id)).filter((r) => r.visit === 1)).toHaveLength(2);
  });

  it('never moves the gate back: a scan with an earlier clock than the last grant loses', async () => {
    const tpl = await accessTemplate();
    const a = await makeDoor([tpl]);
    const b = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const seen: { b?: ScanOutcome } = {};
    const { result } = await beforeBatch(
      kit.env,
      commit,
      async () => {
        kit.clock.advance(5_000);
        seen.b = await grantOf(b.headers, pass);
      },
      () => grantOf(a.headers, pass),
    );
    expect(seen.b?.kind).toBe('ok');
    expect(result).toMatchObject({ kind: 'heads_up', reason: 'in_progress' });
    expect(await gateRow(pass.id)).toMatchObject({ last_at: TEST_NOW + 5_000 });
  });

  it('measures the gap from the visit start: a chain of short re-scans cannot hold one visit open', async () => {
    const tpl = await accessTemplate();
    const d = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const seen: ScanOutcome[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(await grantOf(d.headers, pass));
      if (i < 2) kit.clock.advance(90 * MINUTE);
    }
    expect(seen.map((o) => o.access?.visit)).toEqual([true, false, true]);
    expect(await gateRow(pass.id)).toMatchObject({ count: 2, visit_at: TEST_NOW + 180 * MINUTE });
    // Undoing the visit gives its start back.
    const third = seen[2]?.scanId;
    expect(
      (await kit.post(d.headers, `/scans/${third}/undo`, { idempotencyKey: key() })).status,
    ).toBe(200);
    expect(await gateRow(pass.id)).toMatchObject({ count: 1, visit_at: TEST_NOW });
  });

  it('waives only the reason an override names', () => {
    expect(waiveOf('cooldown')).toEqual({ wait: true, limit: false });
    expect(waiveOf('guest_visits_used')).toEqual({ wait: false, limit: true });
    expect(waiveOf('capacity_full')).toEqual({ wait: false, limit: false });
    expect(waiveOf(null)).toEqual({ wait: false, limit: false });
  });

  it('a cooldown override at the limit still answers guest_visits_used', async () => {
    const tpl = await accessTemplate(rules(30, 60));
    const d = await makeDoor([tpl]);
    const boss = await kit.staff('manager', 'Boss');
    const pass = await kit.scanPass(tpl, { plan: 'guest', visits: 1 });
    expect((await grantOf(d.headers, pass)).kind).toBe('ok');
    kit.clock.advance(40 * MINUTE);
    const held = await grantOf(d.headers, pass);
    expect(held).toMatchObject({ kind: 'heads_up', reason: 'cooldown' });
    const through = await out(
      await act(d.headers, codeOf(pass), {
        overrideOf: held.scanId,
        approval: { staffId: boss.id, pin: boss.pin },
      }),
    );
    expect(through).toMatchObject({ kind: 'refused', reason: 'guest_visits_used' });
    expect(await gateRow(pass.id)).toMatchObject({ count: 1 });
  });

  it('does not apply the template window to an Access card', async () => {
    const tpl = await kit.scanTemplate('Windowed access', {
      actions: [CHECK_IN],
      access: ACCESS,
      window: { until: 'endsAt' },
    });
    const d = await makeDoor([tpl]);
    const past = new Date(kit.clock.now() - 2 * HOUR).toISOString();
    const pass = await kit.scanPass(tpl, { plan: 'gold', endsAt: past });
    expect((await grantOf(d.headers, pass)).kind).toBe('ok');
  });
});

describe('access gate: exits', () => {
  async function tracked(direction: 'out' | 'both') {
    const tpl = await accessTemplate();
    const zone = await makeZone(`exit-${direction}-${Math.random().toString(36).slice(2, 6)}`);
    const d = await makeDoor([tpl], [zone]);
    await run(
      kit.env.DB,
      'UPDATE scanning_sessions SET settings = json_set(settings, ?, ?) WHERE id = ?',
      ['$.direction', direction, d.sessionId],
    );
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    await putPassCheckIn(kit.ctx, { type: 'system', id: null }, pass.id, { mode: 'in_out' }, null);
    return { d, pass };
  }
  const exits = (passId: string) =>
    first<{ n: number }>(
      kit.env.DB,
      "SELECT count(*) AS n FROM scans WHERE pass_id = ? AND direction = 'out' AND outcome = 'ok'",
      [passId],
    );

  it('an out door writes no grant and leaves the visit gate alone', async () => {
    const { d, pass } = await tracked('both');
    expect((await grantOf(d.headers, pass)).access?.visit).toBe(true);
    const before = await gateRow(pass.id);
    const left = await out(
      await act(d.headers, codeOf(pass), { actionId: 'check_in', direction: 'out' }),
    );
    expect(left).toMatchObject({ kind: 'ok', access: null, checkIn: { direction: 'out' } });
    expect(await gateRow(pass.id)).toEqual(before);
    expect(await exits(pass.id)).toEqual({ n: 1 });
    const rows = await scanRows(pass.id);
    expect(rows.filter((r) => r.access_plan !== null)).toHaveLength(1);
  });

  it('an out-only door and a both door that comes back in run the decision again', async () => {
    const { d, pass } = await tracked('both');
    await grantOf(d.headers, pass);
    await out(await act(d.headers, codeOf(pass), { actionId: 'check_in', direction: 'out' }));
    kit.clock.advance(HOUR);
    const back = await out(
      await act(d.headers, codeOf(pass), { actionId: 'check_in', direction: 'in' }),
    );
    expect(back).toMatchObject({ kind: 'ok', access: { plan: { id: 'gold' } } });
    const only = await tracked('out');
    const refused = await out(
      await act(only.d.headers, codeOf(only.pass), { actionId: 'check_in' }),
    );
    expect(refused.access).toBeNull();
    expect(await gateRow(only.pass.id)).toBeNull();
  });
});

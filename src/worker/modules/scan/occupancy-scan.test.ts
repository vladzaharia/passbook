import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { all, first, stmt } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { updatePass } from '../passes/service.ts';
import { accessTemplate, gateRow } from './access-test-fixtures.ts';
import { HOUR, kit, MINUTE, setupActionFixture } from './act-test-fixtures.ts';
import {
  placeRow,
  scanAt,
  trackedZone,
  undoScan,
  zoneDoor,
} from './occupancy-scan-test-fixtures.ts';
import {
  clearScanRetentionDeleteStmt,
  readVerifiedScanRetentionProofs,
  stageScanRetentionDeleteStmt,
} from './repo-scan-retention.ts';
import { prepareScanRetentionDelete } from './scan-retention-proof.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const scanRow = (id: string | null) =>
  first<{ direction: string | null; presence_scope: string | null; out_cause: string | null }>(
    kit.env.DB,
    'SELECT direction, presence_scope, out_cause FROM scans WHERE id = ?',
    [id],
  );

describe('occupancy at a door: entry and exit', () => {
  it('enters the first tracked zone, and an exit door taps out without touching the visit gate', async () => {
    const tpl = await accessTemplate();
    const lobby = await trackedZone({ occupancy: 'off' });
    const gym = await trackedZone({ occupancy: 'enforce' });
    const way = await zoneDoor(tpl, [lobby, gym]);
    const exit = await zoneDoor(tpl, [gym], 'out');
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const entry = await scanAt(way, pass);
    expect(entry).toMatchObject({
      kind: 'ok',
      access: { visit: true },
      occupancy: {
        place: { kind: 'zone', id: gym },
        direction: 'in',
        state: 'in',
        inNow: 1,
        via: expect.any(String),
      },
    });
    expect(await placeRow(pass.id, gym)).toMatchObject({
      state: 'in',
      due_at: TEST_NOW + 12 * HOUR,
    });
    expect(await scanRow(entry.scanId)).toMatchObject({
      direction: 'in',
      presence_scope: `zone:${gym}`,
    });
    const gate = await gateRow(pass.id);

    kit.clock.advance(30 * MINUTE);
    const left = await scanAt(exit, pass);
    expect(left).toMatchObject({
      kind: 'ok',
      access: null,
      occupancy: {
        direction: 'out',
        state: 'out',
        stayMs: 30 * MINUTE,
        inNow: 0,
        via: expect.any(String),
      },
    });
    expect(await placeRow(pass.id, gym)).toMatchObject({ state: 'out', due_at: null });
    expect(await scanRow(left.scanId)).toMatchObject({ direction: 'out', out_cause: null });
    // An exit counts no visit and moves no wait.
    expect(await gateRow(pass.id)).toEqual(gate);
    // The signed ledger names the same place as the scan row (retention proves one by the other).
    const signed = await all<{ kind: string; scope: string | null }>(
      kit.env.DB,
      `SELECT kind, json_extract(data, '$.authority.presenceScope') AS scope
       FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.checked_%' ORDER BY at, id`,
      [pass.id],
    );
    expect(signed).toEqual([
      { kind: 'scan.checked_in', scope: `zone:${gym}` },
      { kind: 'scan.checked_out', scope: `zone:${gym}` },
    ]);
    // Both scans survive the pass's deletion with a proof that verifies.
    const prepared = await prepareScanRetentionDelete(kit.env, pass);
    await kit.env.DB.batch([
      stageScanRetentionDeleteStmt(kit.env.DB, pass.id, prepared),
      stmt(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]),
      clearScanRetentionDeleteStmt(kit.env.DB, prepared),
    ]);
    const ids = [entry.scanId, left.scanId].map(String);
    const proven = await readVerifiedScanRetentionProofs(
      kit.env.DB,
      kit.env,
      { mode: 'live' },
      ids,
    );
    expect(ids.map((id) => proven.has(id))).toEqual([true, true]);
  });

  it('taps out a suspended pass (leaving is never refused for who you are)', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone();
    const way = await zoneDoor(tpl, [gym]);
    const exit = await zoneDoor(tpl, [gym], 'out');
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    expect((await scanAt(way, pass)).kind).toBe('ok');
    await updatePass(
      jobCtxOf(kit),
      { type: 'user', id: 'admin-1' },
      pass.id,
      { input: { status: 'Suspended' } },
      { scope: kit.org.id },
    );
    expect(await scanAt(way, pass)).toMatchObject({ kind: 'refused', reason: 'suspended' });
    expect(await scanAt(exit, pass)).toMatchObject({ kind: 'ok', occupancy: { state: 'out' } });
  });

  it('answers an exit with nothing to close as not_inside and changes nothing', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone();
    const exit = await zoneDoor(tpl, [gym], 'out');
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    expect(await scanAt(exit, pass)).toMatchObject({ kind: 'heads_up', reason: 'not_inside' });
    expect(await placeRow(pass.id, gym)).toBeNull();
  });

  it('holds a second entry at a zone that requires tap out, and keeps since on a track-only zone', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce' });
    const pool = await trackedZone({ occupancy: 'track' });
    const gymDoor = await zoneDoor(tpl, [gym]);
    const poolDoor = await zoneDoor(tpl, [pool]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    await scanAt(gymDoor, pass);
    await scanAt(poolDoor, pass);
    kit.clock.advance(10 * MINUTE);
    expect(await scanAt(gymDoor, pass)).toMatchObject({
      kind: 'heads_up',
      reason: 'still_inside',
      occupancy: { state: 'in', since: TEST_NOW },
    });
    expect(await scanAt(poolDoor, pass)).toMatchObject({
      kind: 'ok',
      occupancy: { state: 'in', since: TEST_NOW },
    });
    expect(await placeRow(pass.id, pool)).toMatchObject({ entered_at: TEST_NOW });
  });
});

describe('occupancy at a door: Auto and the turnaround hold', () => {
  it('flips in and out on a Both door, holds a flip under two minutes, and lets a pinned direction through', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce' });
    const desk = await zoneDoor(tpl, [gym], 'both');
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    expect(await scanAt(desk, pass)).toMatchObject({
      kind: 'ok',
      occupancy: { direction: 'in', auto: true },
    });
    kit.clock.advance(MINUTE);
    expect(await scanAt(desk, pass)).toMatchObject({
      kind: 'heads_up',
      reason: 'still_inside',
      overridable: false,
      occupancy: { state: 'in', turnaround: 'out' },
    });
    expect(await placeRow(pass.id, gym)).toMatchObject({ state: 'in' });
    expect(await scanAt(desk, pass, 'out')).toMatchObject({
      kind: 'ok',
      occupancy: { direction: 'out', auto: false },
    });
    kit.clock.advance(MINUTE);
    expect(await scanAt(desk, pass)).toMatchObject({
      kind: 'heads_up',
      reason: 'not_inside',
      occupancy: { state: 'out', turnaround: 'in' },
    });
    kit.clock.advance(2 * MINUTE);
    expect(await scanAt(desk, pass)).toMatchObject({ kind: 'ok', occupancy: { direction: 'in' } });
  });
});

describe('occupancy with access: visits', () => {
  it('lets a one-visit guest step out and back in the same visit, and counts a track-only repeat once', async () => {
    const tpl = await accessTemplate();
    const pool = await trackedZone({ occupancy: 'track' });
    const desk = await zoneDoor(tpl, [pool], 'both');
    const pass = await kit.scanPass(tpl, { plan: 'guest', visits: 1 });
    expect(await scanAt(desk, pass)).toMatchObject({ kind: 'ok', access: { visit: true } });
    kit.clock.advance(10 * MINUTE);
    expect(await scanAt(desk, pass, 'in')).toMatchObject({
      kind: 'ok',
      access: { visit: false, visits: { used: 1 } },
      occupancy: { since: TEST_NOW },
    });
    kit.clock.advance(10 * MINUTE);
    expect(await scanAt(desk, pass)).toMatchObject({ kind: 'ok', occupancy: { direction: 'out' } });
    kit.clock.advance(10 * MINUTE);
    expect(await scanAt(desk, pass)).toMatchObject({ kind: 'ok', access: { visit: false } });
    expect(await gateRow(pass.id)).toMatchObject({ count: 1, visit_at: TEST_NOW });
    kit.clock.advance(10 * MINUTE);
    await scanAt(desk, pass);
    kit.clock.advance(3 * HOUR);
    expect(await scanAt(desk, pass)).toMatchObject({
      kind: 'refused',
      reason: 'guest_visits_used',
    });
    expect(await placeRow(pass.id, pool)).toMatchObject({ state: 'out' });
  });
});

describe('occupancy undo', () => {
  it('undoes an access-granted entry: the gate and the row both go back', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce' });
    const way = await zoneDoor(tpl, [gym]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const entry = await scanAt(way, pass);
    expect((await undoScan(way, entry.scanId)).status).toBe(200);
    expect(await gateRow(pass.id)).toBeNull();
    expect(await placeRow(pass.id, gym)).toBeNull();
    expect(
      await all(kit.env.DB, 'SELECT rev FROM scan_place_revs WHERE place = ?', [`zone:${gym}`]),
    ).toEqual([{ rev: 2 }]);
    expect((await scanAt(way, pass)).kind).toBe('ok');
  });

  it('undoes a tap-out: the row is in again with its since, and the gate is untouched', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce' });
    const way = await zoneDoor(tpl, [gym]);
    const exit = await zoneDoor(tpl, [gym], 'out');
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    await scanAt(way, pass);
    const gate = await gateRow(pass.id);
    kit.clock.advance(20 * MINUTE);
    const left = await scanAt(exit, pass);
    expect((await undoScan(exit, left.scanId)).status).toBe(200);
    expect(await placeRow(pass.id, gym)).toMatchObject({ state: 'in', entered_at: TEST_NOW });
    expect(await gateRow(pass.id)).toEqual(gate);
    expect(await scanAt(way, pass)).toMatchObject({ kind: 'heads_up', reason: 'still_inside' });
  });

  it('refuses an undo after a later move of the pass', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'track' });
    const way = await zoneDoor(tpl, [gym]);
    const exit = await zoneDoor(tpl, [gym], 'out');
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    await scanAt(way, pass);
    kit.clock.advance(5 * MINUTE);
    const left = await scanAt(exit, pass);
    kit.clock.advance(5 * MINUTE);
    await scanAt(way, pass);
    expect((await undoScan(exit, left.scanId)).status).toBe(409);
    expect(await placeRow(pass.id, gym)).toMatchObject({ state: 'in' });
  });
});

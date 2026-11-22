import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import type { Pass } from '../passes/repo-map.ts';
import { updatePass } from '../passes/service.ts';
import { accessTemplate } from './access-test-fixtures.ts';
import { act, kit, out, setupActionFixture } from './act-test-fixtures.ts';
import { placeRow, scanAt, trackedZone, zoneDoor } from './occupancy-scan-test-fixtures.ts';
import { batch, batchOf, item } from './offline-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

// OC4: leaving is never refused for who you are. A tap-out of a voided, suspended or ended pass
// records; every entry (and every other action) on such a pass stays refused.
beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const STATES = ['active', 'voided', 'voided_wallet', 'expired', 'suspended'] as const;
type State = (typeof STATES)[number];
const MODES = ['online', 'batch'] as const;
type Mode = (typeof MODES)[number];

const refusal: Record<State, string | null> = {
  active: null,
  voided: 'voided',
  voided_wallet: 'voided',
  expired: 'expired',
  suspended: 'suspended',
};

async function setState(pass: Pass, state: State): Promise<void> {
  if (state === 'voided')
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
  if (state === 'voided_wallet' || state === 'expired')
    await run(
      kit.env.DB,
      'UPDATE pass_versions SET pass_json=json_set(pass_json,?,json(?)) WHERE pass_id=? AND version=?',
      [
        state === 'expired' ? '$.expirationDate' : '$.voided',
        JSON.stringify(
          state === 'expired' ? new Date(kit.clock.now() - 1_000).toISOString() : true,
        ),
        pass.id,
        pass.version,
      ],
    );
  if (state === 'suspended')
    await updatePass(
      jobCtxOf(kit),
      { type: 'user', id: 'admin-1' },
      pass.id,
      { input: { status: 'Suspended' } },
      { scope: kit.org.id },
    );
}

/** One scan at a door, online through `/actions` or as a queued read through `/batch`. */
async function scan(
  mode: Mode,
  door: Awaited<ReturnType<typeof zoneDoor>>,
  pass: Pass,
  direction: 'in' | 'out',
): Promise<ScanOutcome> {
  if (mode === 'online') return scanAt(door, pass, direction);
  const res = await batch(door.headers, [item(pass.scanCode ?? '', { direction })]);
  expect(res.status).toBe(200);
  const [only] = (await batchOf(res)).items;
  if (!only) throw new Error('no batch answer');
  return only.outcome;
}

/** A door that takes queued reads, as a device does after a dropped connection. */
async function queuing(door: Awaited<ReturnType<typeof zoneDoor>>) {
  await run(
    kit.env.DB,
    "UPDATE scanning_sessions SET settings = json_set(settings, '$.whenOffline', 'decide') WHERE id = ?",
    [door.sessionId],
  );
  return door;
}

async function place() {
  const tpl = await accessTemplate();
  const gym = await trackedZone();
  return {
    tpl,
    gym,
    way: await queuing(await zoneDoor(tpl, [gym], 'in')),
    exit: await queuing(await zoneDoor(tpl, [gym], 'out')),
  };
}

const rowOf = (scanId: string | null) =>
  first<{ direction: string | null; outcome: string | null; offline: number }>(
    kit.env.DB,
    'SELECT direction, outcome, offline FROM scans WHERE id = ?',
    [scanId],
  );

const recordedStates = async (passId: string) =>
  (
    await all<{ s: string | null }>(
      kit.env.DB,
      "SELECT json_extract(data, '$.authority.passState') AS s FROM pass_events WHERE pass_id = ? AND json_extract(data, '$.authority.passState') IS NOT NULL",
      [passId],
    )
  ).map((r) => r.s);

describe.each(MODES)('OC4 exits skip pass validity (%s)', (mode) => {
  it.each(STATES)('direction out: a %s pass taps out', async (state) => {
    const p = await place();
    const pass = await kit.scanPass(p.tpl, { plan: 'gold' });
    expect((await scan('online', p.way, pass, 'in')).kind).toBe('ok');
    await setState(pass, state);
    const exit = await scan(mode, p.exit, pass, 'out');
    expect(exit.kind).toBe('ok');
    // A queued read comes back without its card; the place row below is the proof.
    if (mode === 'online') expect(exit.occupancy).toMatchObject({ direction: 'out', state: 'out' });
    expect(await placeRow(pass.id, p.gym)).toMatchObject({ state: 'out' });
    const row = await rowOf(exit.scanId);
    expect(row).toMatchObject({ direction: 'out', outcome: 'ok' });
    expect(row?.offline === 0).toBe(mode === 'online');
    // The record names the state the pass was in; a live pass records nothing extra.
    const wallet = state === 'active' ? [] : [state === 'expired' ? 'expired' : 'voided'];
    expect(await recordedStates(pass.id)).toEqual(state === 'suspended' ? [] : wallet);
  });

  it.each(STATES)('direction in: a %s pass is refused as before', async (state) => {
    const p = await place();
    const pass = await kit.scanPass(p.tpl, { plan: 'gold' });
    await setState(pass, state);
    const entry = await scan(mode, p.way, pass, 'in');
    const reason = refusal[state];
    if (reason === null) expect(entry.kind).toBe('ok');
    else {
      expect(entry).toMatchObject({ kind: 'refused', reason });
      expect(await placeRow(pass.id, p.gym)).toBeNull();
    }
    expect(await recordedStates(pass.id)).toEqual([]);
  });

  it('an exit of a voided pass that was never inside is the same heads-up as for a live one', async () => {
    const p = await place();
    const pass = await kit.scanPass(p.tpl, { plan: 'gold' });
    await setState(pass, 'voided');
    expect(await scan(mode, p.exit, pass, 'out')).toMatchObject({
      kind: 'heads_up',
      reason: 'not_inside',
    });
    expect(await placeRow(pass.id, p.gym)).toBeNull();
  });
});

describe('OC4 on a plain In/Out scanner (no zones)', () => {
  const door = async () => {
    const tpl = await kit.scanTemplate('Ticket', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({
      templateIds: [tpl],
      settings: { checkIn: { mode: 'in_out' }, direction: 'both' },
    });
    const at = async (pass: Pass) =>
      out(await act(scanner.headers, codeOf(pass), { actionId: 'enter' }));
    return { tpl, at };
  };

  it('taps a voided pass out, and refuses the same pass coming back in', async () => {
    const { tpl, at } = await door();
    const pass = await kit.scanPass(tpl);
    expect((await at(pass)).kind).toBe('ok');
    await setState(pass, 'voided');
    expect(await at(pass)).toMatchObject({ kind: 'ok', checkIn: { direction: 'out' } });
    expect(await at(pass)).toMatchObject({ kind: 'refused', reason: 'voided' });
  });

  it('refuses a voided pass that was never inside at its first scan', async () => {
    const { tpl, at } = await door();
    const pass = await kit.scanPass(tpl);
    await setState(pass, 'voided');
    expect(await at(pass)).toMatchObject({ kind: 'refused', reason: 'voided' });
  });

  it('keeps refusing a voided pass on an In-only scanner', async () => {
    const tpl = await kit.scanTemplate('Ticket', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    await setState(pass, 'voided');
    const outcome = out(
      await act(scanner.headers, codeOf(pass), { actionId: 'enter', direction: 'out' }),
    );
    expect(await outcome).toMatchObject({ kind: 'refused', reason: 'voided' });
  });
});

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import { accessTemplate } from './access-test-fixtures.ts';
import { act, kit, out, setupActionFixture } from './act-test-fixtures.ts';
import { placeRow, scanAt, trackedZone, zoneDoor } from './occupancy-scan-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

// OC4 on the read-first paths: /resolve and the choose flow keep answering a voided pass as voided
// (with their scan row); only an act that names a check-out commits the exit, and it discloses nothing.
beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const door = async (settings: Record<string, unknown> = {}) => {
  const tpl = await kit.scanTemplate('Ticket', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
    flags: [{ input: 'tier', label: 'Unpaid dues', equals: ['overdue'], stop: true }],
  });
  const scanner = await kit.scanner({
    templateIds: [tpl],
    settings: { checkIn: { mode: 'in_out' }, direction: 'both', ...settings },
  });
  const at = async (pass: Pass, over: Record<string, unknown> = {}) =>
    out(await act(scanner.headers, codeOf(pass), { actionId: 'enter', ...over }));
  const resolve = async (pass: Pass) =>
    (await (
      await kit.post(scanner.headers, '/resolve', {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
      })
    ).json()) as ScanOutcome;
  return { tpl, at, resolve, scanner };
};

const void_ = (pass: Pass) =>
  run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
const presence = (pass: Pass) =>
  first<{ state: string }>(kit.env.DB, 'SELECT state FROM scan_presence WHERE pass_id = ?', [
    pass.id,
  ]);
const scanRow = (id: string | null) =>
  first<{ outcome: string; reason: string | null; pass_state: string | null }>(
    kit.env.DB,
    'SELECT outcome, reason, pass_state FROM scans WHERE id = ?',
    [id],
  );

describe('OC4 read-first paths', () => {
  it('resolve answers voided and offers the check-out when the pass is inside', async () => {
    const d = await door();
    const pass = await kit.scanPass(d.tpl);
    expect((await d.at(pass)).kind).toBe('ok');
    await void_(pass);
    const read = await d.resolve(pass);
    expect(read).toMatchObject({ kind: 'refused', reason: 'voided', exitAllowed: true });
    const exit = await d.at(pass, { direction: 'out' });
    expect(exit).toMatchObject({ kind: 'ok', checkIn: { direction: 'out' } });
    expect(await scanRow(exit.scanId)).toMatchObject({ outcome: 'ok', pass_state: 'voided' });
  });

  it('resolve answers plain voided when the pass is not inside', async () => {
    const d = await door();
    const pass = await kit.scanPass(d.tpl);
    await void_(pass);
    const read = await d.resolve(pass);
    expect(read).toMatchObject({ kind: 'refused', reason: 'voided' });
    expect(read.exitAllowed).toBeUndefined();
  });

  it('a choose-flow scanner records a refused voided row, then takes the check-out', async () => {
    const d = await door({ flow: 'choose' });
    const pass = await kit.scanPass(d.tpl);
    expect((await d.at(pass, { actionId: 'enter' })).kind).toBe('ok');
    await void_(pass);
    const refused = await d.at(pass, { actionId: 'auto' });
    expect(refused).toMatchObject({ kind: 'refused', reason: 'voided', exitAllowed: true });
    expect(await scanRow(refused.scanId)).toMatchObject({ outcome: 'refused', reason: 'voided' });
    const exit = await d.at(pass, { actionId: 'auto', direction: 'out' });
    expect(exit).toMatchObject({ kind: 'ok', checkIn: { direction: 'out' } });
  });

  it('an exit of an inactive pass shows no holder, initials or flag label', async () => {
    const d = await door();
    const pass = await kit.scanPass(d.tpl, { tier: 'overdue' });
    expect((await d.at(pass, { confirmed: true })).kind).toBe('ok');
    await void_(pass);
    const exit = await d.at(pass, { direction: 'out' });
    expect(exit.kind).toBe('ok');
    expect(exit.display).toBeNull();
    expect(exit.card).toBeNull();
    expect(exit.flags).toEqual([]);
    expect(JSON.stringify(exit)).not.toMatch(/Anna|Popescu|Unpaid dues/);
  });

  it('an exit of a voided pass that is not inside cannot be let in', async () => {
    const d = await door();
    const pass = await kit.scanPass(d.tpl);
    await void_(pass);
    const held = await d.at(pass, { direction: 'out' });
    expect(held).toMatchObject({ kind: 'heads_up', reason: 'not_inside', overridable: false });
    expect(JSON.stringify(held)).not.toMatch(/Anna|Popescu/);
  });

  it('undoing an exit puts the voided pass back inside', async () => {
    const d = await door();
    const pass = await kit.scanPass(d.tpl);
    await d.at(pass);
    await void_(pass);
    const exit = await d.at(pass, { direction: 'out' });
    expect(await presence(pass)).toMatchObject({ state: 'out' });
    const res = await kit.post(d.scanner.headers, `/scans/${exit.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(res.status).toBe(200);
    expect(await presence(pass)).toMatchObject({ state: 'in' });
    expect(await d.at(pass, { direction: 'in' })).toMatchObject({
      kind: 'refused',
      reason: 'voided',
    });
  });
});

describe('OC4 on a zone-only Both desk', () => {
  it('resolve offers the check-out for a voided pass that is inside, and it commits', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone();
    const desk = await zoneDoor(tpl, [gym], 'both');
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    expect((await scanAt(desk, pass, 'in')).kind).toBe('ok');
    await void_(pass);
    const res = await kit.post(desk.headers, '/resolve', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
    });
    expect((await res.json()) as ScanOutcome).toMatchObject({
      kind: 'refused',
      reason: 'voided',
      exitAllowed: true,
    });
    expect(await scanAt(desk, pass, 'out')).toMatchObject({ kind: 'ok' });
    expect(await placeRow(pass.id, gym)).toMatchObject({ state: 'out' });
  });
});

describe('OC4 on a value-first scanner', () => {
  it('Check out commits even when the default action is a value action', async () => {
    const tpl = await kit.scanTemplate('Punch', {
      actions: [
        { id: 'stamp', label: 'Add stamp', kind: 'add', input: 'stamps' },
        { id: 'enter', label: 'Check in', kind: 'check_in' },
      ],
    });
    const scanner = await kit.scanner({
      templateIds: [tpl],
      settings: { checkIn: { mode: 'in_out' }, direction: 'both' },
    });
    const pass = await kit.scanPass(tpl);
    const at = async (over: Record<string, unknown>) =>
      out(await act(scanner.headers, codeOf(pass), over));
    expect((await at({ actionId: 'enter' })).kind).toBe('ok');
    await void_(pass);
    const exit = await at({ actionId: 'auto', direction: 'out' });
    expect(exit).toMatchObject({ kind: 'ok', checkIn: { direction: 'out' } });
  });
});

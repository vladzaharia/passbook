import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { sweepClass } from '../retention/sweep.ts';
import { act, kit, out, setupActionFixture } from './act-test-fixtures.ts';
import { batch, batchOf, item, LIST, rosterOf, ticketTemplate } from './offline-test-fixtures.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const DAY = 86_400_000;
const rowsOf = (sql: string, params: (string | number)[] = []) =>
  all<Record<string, unknown>>(kit.env.DB, sql, params);

async function door(settings: Record<string, unknown> = LIST) {
  const tpl = await ticketTemplate();
  const scanner = await kit.scanner({ templateIds: [tpl], settings });
  return { tpl, scanner, headers: scanner.headers };
}

describe('syncing queued reads', () => {
  it('checks a listed pass in, with no card on the way out', async () => {
    const { tpl, headers } = await door();
    const pass = await kit.scanPass(tpl);
    const roster = await rosterOf(headers);
    const res = await batch(headers, [item(pass.scanCode ?? '', { door: 'listed' })], roster);
    expect(res.status).toBe(200);
    const [only] = (await batchOf(res)).items;
    expect(only?.outcome).toMatchObject({ kind: 'ok', card: null, display: null, value: null });
    expect(only?.conflict).toBe(false);
    expect(
      await rowsOf('SELECT door, conflict, outcome FROM scan_offline_reads WHERE org_id = ?', [
        kit.org.id,
      ]),
    ).toContainEqual({
      door: 'listed',
      conflict: 0,
      outcome: 'ok',
    });
  });

  it('records a pass voided online after the door queued it as a conflict', async () => {
    const { tpl, headers } = await door();
    const pass = await kit.scanPass(tpl);
    const roster = await rosterOf(headers);
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
    const [only] = (
      await batchOf(await batch(headers, [item(pass.scanCode ?? '', { door: 'listed' })], roster))
    ).items;
    expect(only?.outcome).toMatchObject({ kind: 'refused', reason: 'voided' });
    expect(only?.conflict).toBe(true);
    const rows = await rowsOf(
      'SELECT conflict, outcome, reason FROM scan_offline_reads WHERE idempotency_key = ?',
      [only?.idempotencyKey ?? ''],
    );
    expect(rows).toEqual([{ conflict: 1, outcome: 'refused', reason: 'voided' }]);
  });

  it('is idempotent: a second upload returns the first answers and writes nothing new', async () => {
    const { tpl, headers } = await door();
    const pass = await kit.scanPass(tpl);
    const one = item(pass.scanCode ?? '');
    const first = await batchOf(await batch(headers, [one]));
    const again = await batchOf(await batch(headers, [one]));
    expect(again.items[0]?.outcome).toMatchObject({
      kind: first.items[0]?.outcome.kind,
      scanId: first.items[0]?.outcome.scanId,
      replay: true,
    });
    expect(await rowsOf('SELECT 1 FROM scans WHERE pass_id = ?', [pass.id])).toHaveLength(1);
    expect(
      await rowsOf('SELECT 1 FROM scan_offline_reads WHERE idempotency_key = ?', [
        one.idempotencyKey,
      ]),
    ).toHaveLength(1);
  });

  it('first scan wins across devices: an online check-in before the sync makes the queued read a conflict', async () => {
    const { tpl, headers } = await door();
    const other = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    expect(
      (await out(await act(other.headers, { code: pass.scanCode, method: 'camera' }))).kind,
    ).toBe('ok');
    const [only] = (
      await batchOf(await batch(headers, [item(pass.scanCode ?? '', { door: 'listed' })]))
    ).items;
    expect(only?.outcome).toMatchObject({ kind: 'heads_up', reason: 'already_done' });
    expect(only?.conflict).toBe(true);
  });

  it('applies reads oldest first whatever the upload order', async () => {
    const { tpl, headers } = await door();
    const pass = await kit.scanPass(tpl);
    const now = kit.clock.now();
    const late = item(pass.scanCode ?? '', { clientTs: now - 1000 });
    const early = item(pass.scanCode ?? '', { clientTs: now - 5000 });
    const res = await batchOf(await batch(headers, [late, early]));
    expect(res.items.map((i) => i.idempotencyKey)).toEqual([
      late.idempotencyKey,
      early.idempotencyKey,
    ]);
    expect(res.items[1]?.outcome.kind).toBe('ok');
    expect(res.items[0]?.outcome.kind).toBe('heads_up');
  });

  it('records a door refusal and never acts on it', async () => {
    const { tpl, headers } = await door();
    const pass = await kit.scanPass(tpl);
    const refused = item(pass.scanCode ?? '', { door: 'refused' });
    const [only] = (await batchOf(await batch(headers, [refused]))).items;
    expect(only?.outcome.kind).toBe('refused');
    expect(only?.conflict).toBe(false);
    expect(await rowsOf('SELECT 1 FROM scans WHERE pass_id = ?', [pass.id])).toHaveLength(0);
    expect(
      await rowsOf('SELECT door, scan_id FROM scan_offline_reads WHERE idempotency_key = ?', [
        refused.idempotencyKey,
      ]),
    ).toEqual([{ door: 'refused', scan_id: null }]);
  });

  it('Staff decide syncs an unverified entry, and a bad one is a conflict', async () => {
    const { tpl, headers } = await door({ offline: false, whenOffline: 'decide' });
    const good = await kit.scanPass(tpl);
    const res = await batchOf(
      await batch(headers, [
        item(good.scanCode ?? '', { door: 'unverified' }),
        item('NOT-A-CODE-0001', { door: 'unverified' }),
      ]),
    );
    expect(res.items[0]?.outcome.kind).toBe('ok');
    expect(res.items[1]).toMatchObject({ conflict: true, outcome: { kind: 'refused' } });
  });

  it('Stop records reads taken after the change as ended, and keeps those taken before it', async () => {
    const { tpl, headers } = await door({ offline: false, whenOffline: 'stop' });
    const [before, after] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    const now = kit.clock.now();
    const res = await batch(headers, [
      item(before.scanCode ?? '', { clientTs: now - 60_000 }),
      item(after.scanCode ?? '', { clientTs: now + 1000 }),
    ]);
    expect(res.status).toBe(200);
    const [kept, ended] = (await batchOf(res)).items;
    expect(kept?.outcome.kind).toBe('ok');
    expect(ended?.outcome).toMatchObject({ kind: 'heads_up', reason: 'ended' });
    expect(await rowsOf('SELECT 1 FROM scans WHERE pass_id = ?', [after.id])).toHaveLength(0);
    expect((await batch(kit.admin(), [item(before.scanCode ?? '')])).status).toBeGreaterThanOrEqual(
      400,
    );
  });

  it('marks Staff decide entries as unverified', async () => {
    const { tpl, headers } = await door({ offline: false, whenOffline: 'decide' });
    const pass = await kit.scanPass(tpl);
    await batch(headers, [item(pass.scanCode ?? '', { door: 'unverified' })]);
    expect(await rowsOf('SELECT offline FROM scans WHERE pass_id = ?', [pass.id])).toEqual([
      { offline: 2 },
    ]);
  });

  it('a list-mode read is marked 1; a replay keeps the first answer after the session went to Stop', async () => {
    const { tpl, scanner, headers } = await door();
    const pass = await kit.scanPass(tpl);
    const roster = await rosterOf(headers);
    const sent = item(pass.scanCode ?? '', { door: 'listed', clientTs: kit.clock.now() - 1000 });
    await batch(headers, [sent], roster);
    expect(await rowsOf('SELECT offline FROM scans WHERE pass_id = ?', [pass.id])).toEqual([
      { offline: 1 },
    ]);
    await run(
      kit.env.DB,
      'UPDATE scanners SET settings = ?, updated_at = updated_at + 1 WHERE id = ?',
      [
        JSON.stringify({
          ...LIST,
          whenOffline: 'stop',
          offline: false,
          flow: 'auto',
          defaultActionId: null,
          roleWithoutSignIn: 'door',
          staffSignIn: false,
          letInAgain: 'anyone',
          reader: 'none',
          lookup: true,
          dailyAmount: null,
        }),
        scanner.id,
      ],
    );
    const again = (await batchOf(await batch(headers, [sent]))).items[0];
    expect(again?.outcome).toMatchObject({ kind: 'ok', replay: true });
  });

  it('a stale roster stamp, cut before the config changed, does not label a read listed', async () => {
    const { tpl, scanner, headers } = await door();
    const pass = await kit.scanPass(tpl);
    const roster = await rosterOf(headers);
    await run(kit.env.DB, 'UPDATE scanners SET updated_at = updated_at + 1 WHERE id = ?', [
      scanner.id,
    ]);
    const sent = item(pass.scanCode ?? '', { door: 'listed' });
    await batch(headers, [sent], roster);
    expect(
      await rowsOf('SELECT door FROM scan_offline_reads WHERE idempotency_key = ?', [
        sent.idempotencyKey,
      ]),
    ).toEqual([{ door: 'unverified' }]);
  });

  it('a daily check-in read at 23:50 and synced after midnight counts on its own day', async () => {
    const tpl = await kit.scanTemplate('Daily', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'daily' }],
    });
    const scanner = await kit.scanner({ templateIds: [tpl], settings: LIST });
    const pass = await kit.scanPass(tpl);
    const now = kit.clock.now();
    const midnight = now - (now % DAY);
    const late = midnight - 10 * 60_000;
    kit.clock.set(midnight + 5 * 60_000);
    const [only] = (
      await batchOf(await batch(scanner.headers, [item(pass.scanCode ?? '', { clientTs: late })]))
    ).items;
    expect(only?.outcome.kind).toBe('ok');
    const today = await out(await act(scanner.headers, { code: pass.scanCode, method: 'camera' }));
    expect(today.kind).toBe('ok');
  });

  it('clamps a read from the future and records one older than a day as ended', async () => {
    const { tpl, headers } = await door();
    const [ahead, stale] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    const now = kit.clock.now();
    const res = await batchOf(
      await batch(headers, [
        item(ahead.scanCode ?? '', { clientTs: now + DAY }),
        item(stale.scanCode ?? '', { clientTs: now - 2 * DAY }),
      ]),
    );
    expect(res.items[0]?.outcome.kind).toBe('ok');
    expect(res.items[1]?.outcome).toMatchObject({ kind: 'heads_up', reason: 'ended' });
    expect(await rowsOf('SELECT client_ts FROM scans WHERE pass_id = ?', [ahead.id])).toEqual([
      { client_ts: now },
    ]);
    expect(await rowsOf('SELECT 1 FROM scans WHERE pass_id = ?', [stale.id])).toHaveLength(0);
  });

  it('a read made after its roster expired, or under a forged window, does not count as listed', async () => {
    const { tpl, headers } = await door();
    const [a, b] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    const roster = await rosterOf(headers);
    const expired = item(a.scanCode ?? '', { door: 'listed', clientTs: roster.validUntil + 1000 });
    kit.clock.set(roster.validUntil + 2000);
    const forged = item(b.scanCode ?? '', { door: 'listed', clientTs: kit.clock.now() });
    const res = await batchOf(await kit.post(headers, '/batch', { items: [expired], roster }));
    expect(res.items[0]?.outcome).toMatchObject({ kind: 'heads_up', reason: 'ended' });
    const bad = await batchOf(
      await kit.post(headers, '/batch', {
        items: [forged],
        roster: { ...roster, validUntil: roster.validUntil + DAY },
      }),
    );
    expect(bad.items[0]?.outcome.kind).toBe('ok');
    expect(
      await rowsOf('SELECT door FROM scan_offline_reads WHERE idempotency_key = ?', [
        forged.idempotencyKey,
      ]),
    ).toEqual([{ door: 'unverified' }]);
  });

  it('offline reads age out with scans, under a receipt', async () => {
    const { tpl, headers } = await door();
    const pass = await kit.scanPass(tpl);
    const sent = item(pass.scanCode ?? '');
    await batch(headers, [sent]);
    const left = () =>
      rowsOf('SELECT pass_id FROM scan_offline_reads WHERE idempotency_key = ?', [
        sent.idempotencyKey,
      ]);
    expect(await left()).toEqual([{ pass_id: pass.id }]);
    kit.clock.advance(5 * 365 * DAY);
    await sweepClass(kit.ctx, 'scans', undefined, 'scan_offline');
    expect(await left()).toEqual([]);
    expect(
      await rowsOf("SELECT 1 FROM retention_receipts WHERE class = 'scans' AND deleted >= 1"),
    ).not.toHaveLength(0);
  });

  it('a read dated before the last clean online contact is a conflict, never admitted', async () => {
    const { tpl, scanner, headers } = await door();
    const pass = await kit.scanPass(tpl);
    const now = kit.clock.now();
    await run(
      kit.env.DB,
      'INSERT INTO scan_offline_state (scanner_id, org_id, online_at) VALUES (?, ?, ?)',
      [scanner.id, kit.org.id, now],
    );
    const [only] = (
      await batchOf(
        await batch(headers, [item(pass.scanCode ?? '', { clientTs: now - 3_600_000 })]),
      )
    ).items;
    expect(only).toMatchObject({ conflict: true, outcome: { kind: 'heads_up', reason: 'ended' } });
    expect(await rowsOf('SELECT 1 FROM scans WHERE pass_id = ?', [pass.id])).toHaveLength(0);
  });

  it('a clean session poll sets the floor; one with reads queued does not', async () => {
    const { scanner, headers } = await door();
    const floor = () =>
      rowsOf('SELECT online_at FROM scan_offline_state WHERE scanner_id = ?', [scanner.id]);
    await kit.get(headers, '/session?pending=3');
    expect(await floor()).toEqual([]);
    await kit.get(headers, '/session?pending=0');
    expect(await floor()).toEqual([{ online_at: kit.clock.now() }]);
  });

  it('an online scan floors the dates a queued read may carry, with a short slack', async () => {
    const { tpl, headers } = await door();
    const [old, recent] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    const scanned = await kit.scanPass(tpl);
    const now = kit.clock.now();
    expect((await act(headers, { code: scanned.scanCode ?? '', method: 'camera' })).status).toBe(
      200,
    );
    const [backdated, honest] = (
      await batchOf(
        await batch(headers, [
          item(old.scanCode ?? '', { clientTs: now - 3_600_000 }),
          item(recent.scanCode ?? '', { clientTs: now - 60_000 }),
        ]),
      )
    ).items;
    expect(backdated).toMatchObject({
      conflict: true,
      outcome: { kind: 'heads_up', reason: 'ended' },
    });
    expect(honest?.outcome.kind).toBe('ok');
    expect(await rowsOf('SELECT 1 FROM scans WHERE pass_id = ?', [old.id])).toHaveLength(0);
  });

  it('labels a scan its first run left unlabelled when the batch is sent again', async () => {
    const { tpl, headers } = await door({ offline: false, whenOffline: 'decide' });
    const pass = await kit.scanPass(tpl);
    const sent = item(pass.scanCode ?? '', { door: 'unverified' });
    await batch(headers, [sent]);
    // The first run stopped between the scan and its label and record.
    await run(kit.env.DB, 'UPDATE scans SET offline = 0 WHERE pass_id = ?', [pass.id]);
    await run(kit.env.DB, 'DELETE FROM scan_offline_reads WHERE idempotency_key = ?', [
      sent.idempotencyKey,
    ]);
    const [again] = (await batchOf(await batch(headers, [sent]))).items;
    expect(again?.outcome).toMatchObject({ kind: 'ok', replay: true });
    expect(await rowsOf('SELECT offline FROM scans WHERE pass_id = ?', [pass.id])).toEqual([
      { offline: 2 },
    ]);
    expect(
      await rowsOf('SELECT 1 FROM scan_offline_reads WHERE idempotency_key = ?', [
        sent.idempotencyKey,
      ]),
    ).toHaveLength(1);
  });
});

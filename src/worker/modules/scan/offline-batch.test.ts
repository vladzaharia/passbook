import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
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

  it('Stop refuses the whole batch, and an admin cannot send one', async () => {
    const { tpl, headers } = await door({ offline: false, whenOffline: 'stop' });
    const pass = await kit.scanPass(tpl);
    const res = await batch(headers, [item(pass.scanCode ?? '')]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'OFFLINE_OFF' });
    expect(await rowsOf('SELECT 1 FROM scans WHERE pass_id = ?', [pass.id])).toHaveLength(0);
    expect((await batch(kit.admin(), [item(pass.scanCode ?? '')])).status).toBeGreaterThanOrEqual(
      400,
    );
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
});

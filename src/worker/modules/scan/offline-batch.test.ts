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
    // The list is served before the read, as on a real door; only a listed read keeps its own date.
    // (The test clock starts at pairing: the door was last seen before the list was served, as on a real door.)
    await run(kit.env.DB, 'UPDATE scanners SET contact_at = ? WHERE id = ?', [
      midnight - 30 * 60_000,
      scanner.id,
    ]);
    kit.clock.set(midnight - 20 * 60_000);
    const roster = await rosterOf(scanner.headers);
    kit.clock.set(midnight + 5 * 60_000);
    const [only] = (
      await batchOf(
        await batch(
          scanner.headers,
          [item(pass.scanCode ?? '', { clientTs: late, door: 'listed' })],
          roster,
        ),
      )
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

  it('a read dated before the last clean online contact is taken at server time and marked late', async () => {
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
    expect(only?.outcome.kind).toBe('ok');
    expect(
      await rowsOf(
        'SELECT late, client_ts, recorded_ts FROM scan_offline_reads WHERE pass_id = ?',
        [pass.id],
      ),
    ).toEqual([{ late: 1, client_ts: now - 3_600_000, recorded_ts: now }]);
    expect(await rowsOf('SELECT at FROM scans WHERE pass_id = ?', [pass.id])).toEqual([
      { at: now },
    ]);
  });

  it('a read dated before the list it carries was cut is taken at server time and marked late', async () => {
    const { tpl, scanner, headers } = await door();
    const pass = await kit.scanPass(tpl);
    const roster = await rosterOf(headers);
    const read = item(pass.scanCode ?? '', { clientTs: roster.asOf - 3_600_000, door: 'listed' });
    const [only] = (await batchOf(await batch(headers, [read], roster))).items;
    expect(only?.outcome.kind).toBe('ok');
    expect(
      await rowsOf('SELECT late, recorded_ts FROM scan_offline_reads WHERE scanner_id = ?', [
        scanner.id,
      ]),
    ).toEqual([{ late: 1, recorded_ts: kit.clock.now() }]);
  });

  it('a read inside the offline window keeps its own date and is not late', async () => {
    const { tpl, headers } = await door();
    const pass = await kit.scanPass(tpl);
    const roster = await rosterOf(headers);
    kit.clock.advance(600_000);
    const at = roster.asOf + 120_000;
    await batch(headers, [item(pass.scanCode ?? '', { clientTs: at, door: 'listed' })], roster);
    expect(
      await rowsOf('SELECT late, client_ts FROM scan_offline_reads WHERE pass_id = ?', [pass.id]),
    ).toEqual([{ late: 0, client_ts: at }]);
  });

  it('the floor is the last request the door made before the upload, as the server stamped it', async () => {
    const { tpl, scanner, headers } = await door();
    const pass = await kit.scanPass(tpl);
    const now = kit.clock.now();
    // Last seen 10 minutes ago (the server's own stamp): a read dated 20 minutes ago is back-dated, a read dated 8 is not.
    await run(kit.env.DB, 'UPDATE scanners SET contact_at = ? WHERE id = ?', [
      now - 10 * 60_000,
      scanner.id,
    ]);
    kit.clock.set(now - 20 * 60_000);
    const roster = await rosterOf(headers);
    kit.clock.set(now);
    await run(kit.env.DB, 'UPDATE scanners SET contact_at = ? WHERE id = ?', [
      now - 10 * 60_000,
      scanner.id,
    ]);
    const early = item(pass.scanCode ?? '', {
      clientTs: now - 20 * 60_000 + 60_000,
      door: 'listed',
    });
    await batch(headers, [early], roster);
    expect(
      await rowsOf('SELECT late FROM scan_offline_reads WHERE idempotency_key = ?', [
        early.idempotencyKey,
      ]),
    ).toEqual([{ late: 1 }]);
  });

  describe('the floor is a server-written contact, never an upload', () => {
    const contactOf = async (id: string) =>
      (await rowsOf('SELECT contact_at FROM scanners WHERE id = ?', [id]))[0]?.contact_at;
    async function outage() {
      const { tpl, scanner, headers } = await door();
      const roster = await rosterOf(headers);
      const t0 = kit.clock.now();
      await run(kit.env.DB, 'UPDATE scanners SET contact_at = ? WHERE id = ?', [t0, scanner.id]);
      kit.clock.advance(3_600_000);
      const reads = [];
      for (let i = 0; i < 4; i++) {
        const p = await kit.scanPass(tpl);
        reads.push(item(p.scanCode ?? '', { clientTs: t0 + (i + 1) * 60_000, door: 'listed' }));
      }
      return { tpl, scanner, headers, roster, t0, reads };
    }
    const lateCount = async (keys: string[]) =>
      (
        await rowsOf(
          'SELECT COUNT(*) AS n FROM scan_offline_reads WHERE late = 1 AND idempotency_key IN (SELECT value FROM json_each(?))',
          [JSON.stringify(keys)],
        )
      )[0]?.n;

    it('has no read late in a two-chunk upload after a one-hour outage', async () => {
      const { scanner, headers, roster, t0, reads } = await outage();
      const keys = reads.map((r) => r.idempotencyKey);
      const one = await batchOf(await batch(headers, reads.slice(0, 2), roster));
      const two = await batchOf(await batch(headers, reads.slice(2), roster));
      expect([...one.items, ...two.items].map((i) => i.outcome.kind)).toEqual(Array(4).fill('ok'));
      expect(await lateCount(keys)).toBe(0);
      expect(await contactOf(scanner.id)).toBe(t0);
    });

    it('is not moved by POST /device sent just before the upload', async () => {
      const { scanner, headers, roster, t0, reads } = await outage();
      await kit.post(headers, '/device', {});
      expect(await contactOf(scanner.id)).toBe(t0);
      const sent = await batchOf(await batch(headers, reads, roster));
      expect(sent.items.map((i) => i.outcome.kind)).toEqual(Array(4).fill('ok'));
      expect(await lateCount(reads.map((r) => r.idempotencyKey))).toBe(0);
    });

    it('is moved by a session poll, and a device that only uploads gains nothing', async () => {
      const { tpl, scanner, headers, roster, t0, reads } = await outage();
      // Uploads only: reads dated before the last contact stay late however many batches it sends.
      const before = item((await kit.scanPass(tpl)).scanCode ?? '', {
        clientTs: t0 - 30 * 60_000,
        door: 'listed',
      });
      await batch(headers, [before], roster);
      await batch(headers, [], roster);
      expect(await lateCount([before.idempotencyKey])).toBe(1);
      expect(await contactOf(scanner.id)).toBe(t0);
      // A session poll is a contact: the floor moves to now.
      await kit.get(headers, '/session');
      expect(await contactOf(scanner.id)).toBe(kit.clock.now());
      const polled = await batchOf(await batch(headers, reads, roster));
      expect(polled.items.map((i) => i.outcome.kind)).toEqual(Array(4).fill('ok'));
      expect(await lateCount(reads.map((r) => r.idempotencyKey))).toBe(4);
    });
  });

  it('a door that sends its queue first keeps every listed read; once the server has seen the door in between, the reads are taken at sync time', async () => {
    const { tpl, scanner, headers } = await door();
    const roster = await rosterOf(headers);
    kit.clock.advance(2 * 3_600_000);
    const queued = async () => {
      const reads = [];
      for (let i = 0; i < 3; i++) {
        const p = await kit.scanPass(tpl);
        reads.push(
          item(p.scanCode ?? '', { clientTs: roster.asOf + (i + 1) * 60_000, door: 'listed' }),
        );
      }
      return reads;
    };
    const lateOf = (key: string) =>
      rowsOf('SELECT late FROM scan_offline_reads WHERE idempotency_key = ?', [key]);
    const first = await queued();
    const sent = await batchOf(await batch(headers, first, roster));
    expect(sent.items.map((i) => i.outcome.kind)).toEqual(['ok', 'ok', 'ok']);
    expect(await lateOf(first[0]?.idempotencyKey ?? '')).toEqual([{ late: 0 }]);
    // The server saw the door after the reads were dated: they are still admitted, at server time, marked late.
    const second = await queued();
    const live = await kit.scanPass(tpl);
    expect((await act(headers, { code: live.scanCode ?? '', method: 'camera' })).status).toBe(200);
    const after = await batchOf(await batch(headers, second, roster));
    expect(after.items.map((i) => i.outcome.kind)).toEqual(['ok', 'ok', 'ok']);
    expect(await lateOf(second[0]?.idempotencyKey ?? '')).toEqual([{ late: 1 }]);
    expect(scanner.id).toBeTruthy();
  });

  it('a modified client claiming dates before its last clean contact gains no earlier date', async () => {
    const { tpl, headers } = await door();
    const pass = await kit.scanPass(tpl);
    await kit.get(headers, '/session?pending=0');
    const clean = kit.clock.now();
    kit.clock.advance(3_600_000);
    const [only] = (
      await batchOf(
        await batch(headers, [item(pass.scanCode ?? '', { clientTs: clean - 3_600_000 })]),
      )
    ).items;
    expect(only?.outcome.kind).toBe('ok');
    expect(await rowsOf('SELECT at FROM scans WHERE pass_id = ?', [pass.id])).toEqual([
      { at: kit.clock.now() },
    ]);
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

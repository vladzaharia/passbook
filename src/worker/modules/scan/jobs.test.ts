import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeLookup } from '../../../shared/scan-lookup.ts';
import { CRON_QUERY_BUDGET, countQueries } from '../../jobs/query-counter.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { BACKFILL_DONE, backfillScanLookups, dailyScans, reconcileScans } from './jobs.ts';
import { claimScan } from './repo-scans.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let tpl: string;
const DAY = 86_400_000;
const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;

beforeAll(async () => {
  kit = await setupScanKit();
  tpl = await kit.scanTemplate('Gym card', { actions: [CHECK_IN], lookup: { input: 'memberNo' } });
});

/** A pending scan as a crash would leave it: claimed, with the pass and action it was working on. */
async function pending(passId: string, ageMs: number, kind = 'check_in') {
  const id = kit.fx.ids.id();
  await claimScan(kit.env.DB, {
    id,
    orgId: kit.org.id,
    mode: 'live',
    scannerId: 'scanner-x',
    eventId: null,
    actorType: 'scanner',
    actorId: 'scanner-x',
    actorKey: 's:scanner-x',
    staffId: null,
    idempotencyKey: id,
    requestHash: 'h',
    method: 'camera',
    clientTs: 1,
    now: kit.clock.now() - ageMs,
  });
  await run(
    kit.env.DB,
    'UPDATE scans SET pass_id = ?, template_id = ?, action_id = ?, action_kind = ? WHERE id = ?',
    [passId, tpl, 'check_in', kind, id],
  );
  return id;
}

const gate = (passId: string, scanId: string, scope = '') =>
  run(
    kit.env.DB,
    `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
     VALUES (?, 'check_in', ?, ?, 'live', ?, 'check_in', 'in', 1, 1, 1, ?)`,
    [passId, scope, kit.org.id, tpl, scanId],
  );

describe('scan.reconcile', () => {
  it('finalizes a won check-in as ok with one ledger row, and fails a lost or never-gated one', async () => {
    const [won, lost, never] = [
      await kit.scanPass(tpl),
      await kit.scanPass(tpl),
      await kit.scanPass(tpl),
    ];
    const wonId = await pending(won.id, 120_000);
    const lostId = await pending(lost.id, 120_000);
    const neverId = await pending(never.id, 120_000);
    const young = await pending(won.id, 5_000);
    await gate(won.id, wonId);
    await gate(lost.id, 'someone-else');
    await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    const state = async (id: string) =>
      first<{ state: string; outcome: string | null; pass_version: number | null }>(
        kit.env.DB,
        'SELECT state, outcome, pass_version FROM scans WHERE id = ?',
        [id],
      );
    expect(await state(wonId)).toEqual({ state: 'done', outcome: 'ok', pass_version: won.version });
    expect((await state(lostId))?.state).toBe('failed');
    expect((await state(neverId))?.state).toBe('failed');
    expect((await state(young))?.state).toBe('pending');
    const rows = await all<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM pass_events WHERE pass_id = ? AND kind = ?',
      [won.id, 'scan.checked_in'],
    );
    expect(rows).toHaveLength(1);
    // A second run changes nothing.
    await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    expect(
      await all(kit.env.DB, 'SELECT id FROM pass_events WHERE pass_id = ? AND kind = ?', [
        won.id,
        'scan.checked_in',
      ]),
    ).toHaveLength(1);
  });

  it('gives a value scan that never committed its gate back and fails it', async () => {
    const pass = await kit.scanPass(tpl);
    await gate(pass.id, 'first-scan');
    const id = await pending(pass.id, 120_000, 'add');
    await run(
      kit.env.DB,
      `UPDATE scan_gates SET prev_state = 'in', prev_last_at = 1, prev_scan_id = 'first-scan', last_scan_id = ?, state = 'used', count = 2 WHERE pass_id = ?`,
      [id, pass.id],
    );
    await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    expect(
      (await first<{ state: string }>(kit.env.DB, 'SELECT state FROM scans WHERE id = ?', [id]))
        ?.state,
    ).toBe('failed');
    expect(
      await first(
        kit.env.DB,
        'SELECT state, last_scan_id, count FROM scan_gates WHERE pass_id = ?',
        [pass.id],
      ),
    ).toEqual({
      state: 'in',
      last_scan_id: 'first-scan',
      count: 1,
    });
  });

  it('settles 100 rows inside the query budget', async () => {
    const pass = await kit.scanPass(tpl);
    for (let i = 0; i < 100; i++) await pending(pass.id, 3_600_000 + i);
    const counter = countQueries(kit.env);
    await reconcileScans(createServiceContext(counter.env, { clock: kit.clock }));
    expect(counter.count()).toBeLessThanOrEqual(5);
    expect(counter.count()).toBeLessThan(CRON_QUERY_BUDGET);
    const left = await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) AS n FROM scans WHERE state = 'pending' AND at < ?",
      [kit.clock.now() - 60_000],
    );
    expect(left?.n).toBe(0);
  });
});

describe('scan.backfill', () => {
  it('mints scan codes in the app format, hashes barcode and lookup, skips removed barcodes, then stops', async () => {
    const a = await kit.scanPass(tpl, { memberNo: 'GYM-7' });
    const removed = await kit.scanPass(tpl);
    await run(
      kit.env.DB,
      'UPDATE passes SET scan_code = NULL, barcode_hash = NULL, lookup_hash = NULL WHERE id IN (?, ?)',
      [a.id, removed.id],
    );
    await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [removed.id]);
    const ctx = createServiceContext(kit.env, { clock: kit.clock });
    await backfillScanLookups(ctx);
    const row = (id: string) =>
      first<{ scan_code: string | null; barcode_hash: string | null; lookup_hash: string | null }>(
        kit.env.DB,
        'SELECT scan_code, barcode_hash, lookup_hash FROM passes WHERE id = ?',
        [id],
      );
    const filled = await row(a.id);
    expect(filled?.scan_code).toMatch(/^[A-Z2-7]{26}$/);
    expect(filled?.barcode_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(filled?.lookup_hash).toBe(await sha256Hex(normalizeLookup('GYM-7')));
    const kept = await row(removed.id);
    expect(kept?.scan_code).toMatch(/^[A-Z2-7]{26}$/);
    expect(kept?.barcode_hash).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM settings WHERE scope = ? AND key = ?', [
        'system',
        BACKFILL_DONE,
      ]),
    ).toBeNull();
    await backfillScanLookups(ctx);
    expect(
      await first(kit.env.DB, "SELECT value FROM settings WHERE scope = 'system' AND key = ?", [
        BACKFILL_DONE,
      ]),
    ).toEqual({ value: 'true' });
    const counter = countQueries(kit.env);
    await backfillScanLookups(createServiceContext(counter.env, { clock: kit.clock }));
    expect(counter.count()).toBe(1);
  });

  it('works through more than one batch', async () => {
    await run(kit.env.DB, "DELETE FROM settings WHERE scope = 'system' AND key = ?", [
      BACKFILL_DONE,
    ]);
    const passes = await Promise.all(Array.from({ length: 3 }, () => kit.scanPass(tpl)));
    await run(
      kit.env.DB,
      'UPDATE passes SET scan_code = NULL WHERE id IN (?, ?, ?)',
      passes.map((p) => p.id),
    );
    await backfillScanLookups(createServiceContext(kit.env, { clock: kit.clock }));
    const left = await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM passes WHERE scan_code IS NULL',
    );
    expect(left?.n).toBe(0);
  });
});

describe('scan.retention', () => {
  async function scanAt(mode: 'live' | 'test', at: number) {
    const id = kit.fx.ids.id();
    await claimScan(kit.env.DB, {
      id,
      orgId: kit.org.id,
      mode,
      scannerId: null,
      eventId: null,
      actorType: 'scanner',
      actorId: 's',
      actorKey: 's:retention',
      staffId: null,
      idempotencyKey: id,
      requestHash: 'h',
      method: 'camera',
      clientTs: 1,
      now: at,
    });
    return id;
  }

  it('deletes live scans past retention.scansDays and test scans past sandbox.purgeDays', async () => {
    const now = kit.clock.now();
    const oldLive = await scanAt('live', now - 397 * DAY);
    const freshLive = await scanAt('live', now - 300 * DAY);
    const oldTest = await scanAt('test', now - 31 * DAY);
    const freshTest = await scanAt('test', now - 5 * DAY);
    const counter = countQueries(kit.env);
    await dailyScans(createServiceContext(counter.env, { clock: kit.clock }));
    expect(counter.count()).toBeLessThan(CRON_QUERY_BUDGET);
    const present = async (id: string) =>
      (await first(kit.env.DB, 'SELECT id FROM scans WHERE id = ?', [id])) !== null;
    expect(await present(oldLive)).toBe(false);
    expect(await present(freshLive)).toBe(true);
    expect(await present(oldTest)).toBe(false);
    expect(await present(freshTest)).toBe(true);
  });
});

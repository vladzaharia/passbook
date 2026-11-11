import { describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { normalizeLookup } from '../../../shared/scan-lookup.ts';
import { CRON_QUERY_BUDGET, countQueries } from '../../jobs/query-counter.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createJobContext, createServiceContext } from '../../platform/service-context.ts';
import { BACKFILL_DONE, backfillScanLookups, dailyScans } from './jobs.ts';
import { registerReconcileFinalizeCases } from './repo-jobs-reconcile-finalize-cases-fixtures.ts';
import { registerReconcileHolderCases } from './repo-jobs-reconcile-holder-cases-fixtures.ts';
import { registerReconcilePresenceCases } from './repo-jobs-reconcile-presence-cases-fixtures.ts';
import { registerReconcileRaceCases } from './repo-jobs-reconcile-race-cases-fixtures.ts';
import { DAY, kit, registerJobsFixture, scanners, tpl } from './repo-jobs-test-fixtures.ts';
import { claimScan, reopenScan } from './repo-scans.ts';
import { codeOf, key, makeLegacyScanPass } from './test-kit.ts';

registerJobsFixture();

describe('scan.reconcile', () => {
  registerReconcileHolderCases();
  registerReconcilePresenceCases();
  registerReconcileRaceCases();
  registerReconcileFinalizeCases();
});

describe('scan.backfill', () => {
  it('mints scan codes in the app format, hashes barcode and lookup, skips removed barcodes, then stops', async () => {
    const template = await kit.registry.resolve(tpl);
    const a = await makeLegacyScanPass(kit.fx, {
      orgId: kit.org.id,
      template,
      personalization: { memberName: 'Anna Popescu', memberNo: 'GYM-7' },
    });
    const removed = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [removed.id]);
    const ctx = createJobContext(kit.env, 'test', { clock: kit.clock });
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
    await backfillScanLookups(createJobContext(counter.env, 'test', { clock: kit.clock }));
    expect(counter.count()).toBe(1);
  });

  it('backfills multiple legacy passes in one batch', async () => {
    await run(kit.env.DB, "DELETE FROM settings WHERE scope = 'system' AND key = ?", [
      BACKFILL_DONE,
    ]);
    const template = await kit.registry.resolve(tpl);
    const passes = await Promise.all(
      Array.from({ length: 3 }, () => makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template })),
    );
    expect(
      await all(
        kit.env.DB,
        'SELECT scan_code FROM passes WHERE id IN (?, ?, ?)',
        passes.map((p) => p.id),
      ),
    ).toEqual([{ scan_code: null }, { scan_code: null }, { scan_code: null }]);
    await backfillScanLookups(createJobContext(kit.env, 'test', { clock: kit.clock }));
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
      scannerId: scanners[mode].id,
      eventId: null,
      actorType: 'scanner',
      actorId: scanners[mode].id,
      actorKey: `s:${scanners[mode].id}`,
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
    const oldTombstone = await scanAt('live', now - 397 * DAY);
    const freshTombstone = await scanAt('live', now - 5 * DAY);
    for (const id of [oldTombstone, freshTombstone])
      await run(kit.env.DB, "UPDATE scans SET state = 'failed', reason = 'stale' WHERE id = ?", [
        id,
      ]);
    const counter = countQueries(kit.env);
    await dailyScans(createServiceContext(counter.env, { clock: kit.clock }));
    expect(counter.count()).toBeLessThan(CRON_QUERY_BUDGET);
    const present = async (id: string) =>
      (await first(kit.env.DB, 'SELECT id FROM scans WHERE id = ?', [id])) !== null;
    expect(await present(oldLive)).toBe(false);
    expect(await present(freshLive)).toBe(true);
    expect(await present(oldTest)).toBe(false);
    expect(await present(freshTest)).toBe(true);
    expect(await present(oldTombstone)).toBe(false);
    expect(await present(freshTombstone)).toBe(true);
    expect(await reopenScan(kit.env.DB, freshTombstone, now)).toBeNull();
  });

  it('removes expired signed retention evidence and quarantine exclusions with the scan', async () => {
    const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
    const response = await kit.post(scanners.test.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ScanOutcome;
    expect(outcome.kind).toBe('ok');
    if (!outcome.scanId) throw new Error('Missing committed scan');
    const scanId = outcome.scanId;
    expect(
      await first(kit.env.DB, 'SELECT excluded FROM scan_retention_proofs WHERE scan_id = ?', [
        scanId,
      ]),
    ).toEqual({ excluded: 0 });
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    expect(
      await first(kit.env.DB, 'SELECT excluded FROM scan_retention_proofs WHERE scan_id = ?', [
        scanId,
      ]),
    ).toEqual({ excluded: 1 });
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_quarantine_exclusions WHERE scan_id = ?', [
        scanId,
      ]),
    ).toEqual({ scan_id: scanId });

    const future = { now: () => kit.clock.now() + 31 * DAY };
    await dailyScans(createServiceContext(kit.env, { clock: future }));
    expect(await first(kit.env.DB, 'SELECT id FROM scans WHERE id = ?', [scanId])).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_retention_proofs WHERE scan_id = ?', [
        scanId,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_quarantine_exclusions WHERE scan_id = ?', [
        scanId,
      ]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        "SELECT id FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_in'",
        [pass.id],
      ),
    ).not.toBeNull();
  });

  it('prunes expired asset grant provenance in bounded batches without logging references', async () => {
    const now = kit.clock.now();
    const cutoff = now + 120_000;
    const hashes = Array.from({ length: 103 }, (_, i) => i.toString(16).padStart(64, '0'));
    const credentialRef = 'f'.repeat(64);
    await kit.env.DB.batch(
      hashes.map((hash, i) =>
        kit.env.DB.prepare(
          `INSERT INTO scan_asset_grant_provenance (token_hash, org_id, mode, expires_at, credential_refs)
       VALUES (?, ?, ?, ?, ?)`,
        ).bind(
          hash,
          kit.org.id,
          i % 2 === 0 ? 'live' : 'test',
          i < 101 ? now + 60_000 : i === 101 ? cutoff : cutoff + 1,
          JSON.stringify([credentialRef]),
        ),
      ),
    );
    const expired = async () =>
      first<{ n: number }>(
        kit.env.DB,
        `SELECT COUNT(*) AS n FROM scan_asset_grant_provenance
       WHERE token_hash IN (SELECT value FROM json_each(?)) AND expires_at <= ?`,
        [JSON.stringify(hashes), cutoff],
      );
    expect(await expired()).toEqual({ n: 102 });

    const logged: { event: string; data: unknown }[] = [];
    const log = {
      ...kit.ctx.log,
      info: (event: string, data?: Record<string, unknown>) => {
        logged.push({ event, data });
      },
    };
    const counter = countQueries(kit.env);
    const ctx = createServiceContext(counter.env, { clock: { now: () => cutoff }, log });
    await dailyScans(ctx);
    expect(await expired()).toEqual({ n: 2 });
    expect(
      await first(
        kit.env.DB,
        'SELECT expires_at FROM scan_asset_grant_provenance WHERE token_hash = ?',
        [hashes[102]!],
      ),
    ).toEqual({ expires_at: cutoff + 1 });
    await dailyScans(ctx);
    expect(await expired()).toEqual({ n: 0 });
    expect(
      await first(
        kit.env.DB,
        'SELECT expires_at FROM scan_asset_grant_provenance WHERE token_hash = ?',
        [hashes[102]!],
      ),
    ).toEqual({ expires_at: cutoff + 1 });
    expect(counter.count()).toBeLessThan(CRON_QUERY_BUDGET);
    expect(logged.map((entry) => entry.event)).toEqual(['scan.retention', 'scan.retention']);
    const output = JSON.stringify(logged);
    expect(hashes.some((hash) => output.includes(hash))).toBe(false);
    expect(output).not.toContain(credentialRef);
    expect(output).not.toContain('credential_refs');
  });
});

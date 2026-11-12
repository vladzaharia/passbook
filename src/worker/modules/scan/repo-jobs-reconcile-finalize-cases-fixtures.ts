import { expect, it } from 'vitest';
import { CRON_QUERY_BUDGET, countQueries } from '../../jobs/query-counter.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { reconcileScans } from './jobs.ts';
import { gate, kit, pending, scanners, tpl } from './repo-jobs-test-fixtures.ts';
import {
  finalizeStmt,
  ledgerIfFinalizedStmt,
  markScanEffectIntentStmt,
  quarantineGateClaimStmt,
  releaseClaimStmt,
  reopenScan,
} from './repo-scans.ts';

export function registerReconcileFinalizeCases() {
  it('allows an atomic finalized outcome to replace the pending effect intent', async () => {
    const id = await pending(null, 0);
    const at = kit.clock.now();
    expect((await markScanEffectIntentStmt(kit.env.DB, id, at).all()).results).toHaveLength(1);
    expect(
      (
        await finalizeStmt(kit.env.DB, {
          id,
          claimAt: at,
          outcome: 'refused',
          reason: 'not_found',
          passId: null,
          templateId: null,
          actionId: null,
          actionKind: null,
          passVersion: null,
          overrideOf: null,
          approvedBy: null,
        }).all()
      ).results,
    ).toHaveLength(1);
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'done',
      reason: 'not_found',
    });
  });

  it('uses monotonic same-millisecond epochs to fence old releases, verdicts and ledger writes', async () => {
    const pass = await kit.scanPass(tpl);
    const now = kit.clock.now();
    const id = await pending(null, 0);
    await run(kit.env.DB, "UPDATE scans SET state = 'failed' WHERE id = ?", [id]);
    expect(await reopenScan(kit.env.DB, id, now)).toBe(now + 1);
    await releaseClaimStmt(kit.env.DB, id, now).run();
    const event = {
      id: kit.fx.ids.id(),
      org_id: kit.org.id,
      pass_id: pass.id,
      mode: 'live' as const,
      kind: 'scan.rejected' as const,
      device: null,
      actor_type: 'scanner',
      actor_id: scanners.live.id,
      data: '{}',
      at: now,
    };
    await kit.env.DB.batch([
      finalizeStmt(kit.env.DB, {
        id,
        claimAt: now,
        outcome: 'refused',
        reason: 'not_found',
        passId: pass.id,
        templateId: tpl,
        actionId: 'check_in',
        actionKind: 'check_in',
        passVersion: pass.version,
        overrideOf: null,
        approvedBy: null,
      }),
      ledgerIfFinalizedStmt(kit.env.DB, event, id, now, 'refused', { sql: '1', params: [] }),
    ]);
    expect(
      await first(kit.env.DB, 'SELECT state, outcome, reason, at FROM scans WHERE id = ?', [id]),
    ).toEqual({ state: 'pending', outcome: null, reason: null, at: now + 1 });
    expect(
      await all(kit.env.DB, 'SELECT id FROM pass_events WHERE id = ?', [event.id]),
    ).toHaveLength(0);
    await run(kit.env.DB, "UPDATE scans SET state = 'failed' WHERE id = ?", [id]);
    expect(await reopenScan(kit.env.DB, id, now)).toBe(now + 2);
  });

  it.each(['last holder', 'previous holder'] as const)(
    'does not finalize a rejection when the claim is a gate %s',
    async (reference) => {
      const pass = await kit.scanPass(tpl);
      const now = kit.clock.now();
      const id = await pending(null, 0);
      await gate(pass.id, reference === 'last holder' ? id : 'newer-scan');
      if (reference === 'previous holder')
        await run(kit.env.DB, 'UPDATE scan_gates SET prev_scan_id = ? WHERE pass_id = ?', [
          id,
          pass.id,
        ]);
      const event = {
        id: kit.fx.ids.id(),
        org_id: kit.org.id,
        pass_id: pass.id,
        mode: 'live' as const,
        kind: 'scan.rejected' as const,
        device: null,
        actor_type: 'scanner',
        actor_id: scanners.live.id,
        data: '{}',
        at: now,
      };
      await kit.env.DB.batch([
        finalizeStmt(kit.env.DB, {
          id,
          claimAt: now,
          outcome: 'refused',
          reason: 'not_found',
          passId: pass.id,
          templateId: tpl,
          actionId: 'check_in',
          actionKind: 'check_in',
          passVersion: pass.version,
          overrideOf: null,
          approvedBy: null,
        }),
        ledgerIfFinalizedStmt(kit.env.DB, event, id, now, 'refused', { sql: '1', params: [] }),
      ]);
      expect(
        await first(kit.env.DB, 'SELECT state, outcome FROM scans WHERE id = ?', [id]),
      ).toEqual({ state: 'pending', outcome: null });
      expect(
        await all(kit.env.DB, 'SELECT id FROM pass_events WHERE id = ?', [event.id]),
      ).toHaveLength(0);
      await kit.env.DB.batch([
        quarantineGateClaimStmt(kit.env.DB, id, now),
        releaseClaimStmt(kit.env.DB, id, now),
      ]);
      expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual(
        { state: 'failed', reason: 'stale' },
      );
    },
  );

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
}

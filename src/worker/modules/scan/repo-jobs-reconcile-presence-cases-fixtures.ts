import { expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { reconcileScans } from './jobs.ts';
import {
  addPresence,
  gate,
  kit,
  pending,
  reconcileWithRace,
  tpl,
} from './repo-jobs-test-fixtures.ts';
import {
  markScanEffectIntentStmt,
  quarantineGateClaimStmt,
  releaseClaimStmt,
  reopenScan,
} from './repo-scans.ts';

export function registerReconcilePresenceCases() {
  it.each([
    ['last', 'reconcile'],
    ['previous', 'reconcile'],
    ['last', 'cleanup'],
    ['previous', 'cleanup'],
    ['last', 'reopen'],
    ['previous', 'reopen'],
  ] as const)('quarantines a %s presence reference during %s', async (reference, operation) => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    const at = kit.clock.now() - 120_000;
    await addPresence(kit.env.DB, pass.id, id, reference);
    const original = await first(kit.env.DB, 'SELECT * FROM scan_presence WHERE pass_id = ?', [
      pass.id,
    ]);
    expect((await markScanEffectIntentStmt(kit.env.DB, id, at).all()).results).toHaveLength(0);
    expect((await releaseClaimStmt(kit.env.DB, id, at).all()).results).toHaveLength(0);
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'pending',
      reason: null,
    });
    if (operation === 'reconcile') {
      await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    } else if (operation === 'cleanup') {
      await kit.env.DB.batch([
        quarantineGateClaimStmt(kit.env.DB, id, at),
        releaseClaimStmt(kit.env.DB, id, at),
      ]);
    } else {
      await run(kit.env.DB, "UPDATE scans SET state = 'failed' WHERE id = ?", [id]);
    }
    expect(await reopenScan(kit.env.DB, id, kit.clock.now())).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT state, outcome, reason FROM scans WHERE id = ?', [id]),
    ).toEqual({ state: 'failed', outcome: null, reason: 'stale' });
    expect(
      await first(kit.env.DB, 'SELECT * FROM scan_presence WHERE pass_id = ?', [pass.id]),
    ).toEqual(original);
    expect(
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toHaveLength(0);
  });

  it.each(['last', 'previous'] as const)(
    'preserves an observed %s presence reference replaced before the recovery write',
    async (reference) => {
      const pass = await kit.scanPass(tpl);
      const id = await pending(null, 120_000);
      await addPresence(kit.env.DB, pass.id, id, reference);
      const column = reference === 'last' ? 'last_scan_id' : 'prev_scan_id';
      await reconcileWithRace(async (db) => {
        await run(db, `UPDATE scan_presence SET ${column} = ? WHERE pass_id = ?`, [
          'newer-scan',
          pass.id,
        ]);
      });
      expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual(
        { state: 'failed', reason: 'stale' },
      );
      expect(await reopenScan(kit.env.DB, id, kit.clock.now())).toBeNull();
      expect(
        await first(kit.env.DB, `SELECT ${column} AS holder FROM scan_presence WHERE pass_id = ?`, [
          pass.id,
        ]),
      ).toEqual({ holder: 'newer-scan' });
      expect(
        await all(
          kit.env.DB,
          "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'",
          [pass.id],
        ),
      ).toHaveLength(0);
    },
  );

  it.each(['last', 'previous'] as const)(
    'quarantines a %s presence reference acquired after the recovery probe',
    async (reference) => {
      const pass = await kit.scanPass(tpl);
      const id = await pending(null, 120_000);
      await reconcileWithRace((db) => addPresence(db, pass.id, id, reference));
      expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual(
        { state: 'failed', reason: 'stale' },
      );
      expect(await reopenScan(kit.env.DB, id, kit.clock.now())).toBeNull();
      expect(
        await first(
          kit.env.DB,
          'SELECT last_scan_id, prev_scan_id FROM scan_presence WHERE pass_id = ?',
          [pass.id],
        ),
      ).toEqual(
        reference === 'last'
          ? { last_scan_id: id, prev_scan_id: null }
          : { last_scan_id: 'new-scan', prev_scan_id: id },
      );
      expect(
        await all(
          kit.env.DB,
          "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'",
          [pass.id],
        ),
      ).toHaveLength(0);
    },
  );

  it('quarantines a previous gate holder without changing the current holder', async () => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await gate(pass.id, 'new-scan');
    await run(
      kit.env.DB,
      `UPDATE scan_gates SET prev_state = 'in', prev_last_at = 1,
      prev_scan_id = ?, count = 2, last_at = 2 WHERE pass_id = ?`,
      [id, pass.id],
    );
    const held = await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]);
    await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
    expect(
      await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]),
    ).toEqual(held);
    expect(await reopenScan(kit.env.DB, id, kit.clock.now())).toBeNull();
    expect(
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toHaveLength(0);
  });

  it('retains an in-flight claim while a gate references it as the previous holder', async () => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await gate(pass.id, 'new-scan');
    await run(kit.env.DB, 'UPDATE scan_gates SET prev_scan_id = ? WHERE pass_id = ?', [
      id,
      pass.id,
    ]);
    await releaseClaimStmt(kit.env.DB, id, kit.clock.now() - 120_000).run();
    expect(await first(kit.env.DB, 'SELECT state FROM scans WHERE id = ?', [id])).toEqual({
      state: 'pending',
    });
    await kit.env.DB.batch([
      quarantineGateClaimStmt(kit.env.DB, id, kit.clock.now() - 120_000),
      releaseClaimStmt(kit.env.DB, id, kit.clock.now() - 120_000),
    ]);
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
    expect(
      await first(
        kit.env.DB,
        'SELECT last_scan_id, prev_scan_id FROM scan_gates WHERE pass_id = ?',
        [pass.id],
      ),
    ).toEqual({ last_scan_id: 'new-scan', prev_scan_id: id });
  });

  it('does not reopen an unmarked failed claim referenced as a previous holder', async () => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await gate(pass.id, 'new-scan');
    await run(kit.env.DB, 'UPDATE scan_gates SET prev_scan_id = ? WHERE pass_id = ?', [
      id,
      pass.id,
    ]);
    await run(kit.env.DB, "UPDATE scans SET state = 'failed' WHERE id = ?", [id]);
    expect(await reopenScan(kit.env.DB, id, kit.clock.now())).toBeNull();
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
  });

  it.each([
    ['pass revision', 'version = version + 1'],
    ['test-data quarantine', 'test_data_quarantined = 1'],
  ])('does not recover an admission after %s', async (_change, mutation) => {
    const pass = await kit.scanPass(tpl, {}, { mode: 'test' });
    const id = await pending(pass.id, 120_000, 'check_in', 'test');
    await gate(pass.id, id, '', 'test');
    await run(kit.env.DB, `UPDATE passes SET ${mutation} WHERE id = ?`, [pass.id]);
    await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    expect(
      await first(kit.env.DB, 'SELECT state, outcome, reason FROM scans WHERE id = ?', [id]),
    ).toEqual({ state: 'failed', outcome: null, reason: 'stale' });
    expect(
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toHaveLength(0);
  });
}

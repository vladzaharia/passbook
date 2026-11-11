import { expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { gate, kit, pending, reconcileWithRace, tpl } from './repo-jobs-test-fixtures.ts';
import { markScanEffectIntentStmt, releaseClaimStmt, reopenScan } from './repo-scans.ts';

export function registerReconcileRaceCases() {
  it.each([
    ['action', "action_id = 'other-action'"],
    ['scope', "scope = 'event:changed'"],
    ['organization', "org_id = 'other-org'"],
    ['mode', "mode = 'test'"],
    ['template', "template_id = 'other-template'"],
    ['kind', "kind = 'other-kind'"],
    ['state', "state = 'out'"],
    ['count', 'count = count + 1'],
    ['first time', 'first_at = first_at + 1'],
    ['last time', 'last_at = last_at + 1'],
    ['last scan', "last_scan_id = 'other-scan'"],
    ['previous state', "prev_state = 'out'"],
    ['previous time', 'prev_last_at = 2'],
    ['previous scan', "prev_scan_id = 'other-scan'"],
  ])('does not delete a gate whose %s changes after observation', async (_field, mutation) => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await gate(pass.id, id);
    let changed: unknown;
    await reconcileWithRace(async (db) => {
      await run(db, `UPDATE scan_gates SET ${mutation} WHERE pass_id = ?`, [pass.id]);
      changed = await first(db, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]);
    });
    expect(changed).not.toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]),
    ).toEqual(changed);
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
    expect(
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toHaveLength(0);
  });

  it('does not restore an updated gate whose state changed after observation', async () => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await gate(pass.id, id);
    await run(
      kit.env.DB,
      `UPDATE scan_gates SET state = 'used', count = 2,
      prev_state = 'in', prev_last_at = 1, prev_scan_id = 'previous' WHERE pass_id = ?`,
      [pass.id],
    );
    let changed: unknown;
    await reconcileWithRace(async (db) => {
      await run(db, "UPDATE scan_gates SET state = 'out' WHERE pass_id = ?", [pass.id]);
      changed = await first(db, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]);
    });
    expect(
      await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]),
    ).toEqual(changed);
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
  });

  it('quarantines a gate acquired after the recovery probe', async () => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await reconcileWithRace(async () => {
      await gate(pass.id, id);
    });
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
    expect(
      await first(kit.env.DB, 'SELECT last_scan_id FROM scan_gates WHERE pass_id = ?', [pass.id]),
    ).toEqual({ last_scan_id: id });
    expect(await reopenScan(kit.env.DB, id, kit.clock.now())).toBeNull();
  });

  it('preserves a previously observed reference even if it is replaced before the write', async () => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await gate(pass.id, 'new-scan');
    await run(kit.env.DB, 'UPDATE scan_gates SET prev_scan_id = ? WHERE pass_id = ?', [
      id,
      pass.id,
    ]);
    await reconcileWithRace(async (db) => {
      await run(db, "UPDATE scan_gates SET prev_scan_id = 'newer-scan' WHERE pass_id = ?", [
        pass.id,
      ]);
    });
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
    ).toEqual({ last_scan_id: 'new-scan', prev_scan_id: 'newer-scan' });
  });

  it('quarantines a previous-holder reference acquired after the probe', async () => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await gate(pass.id, 'new-scan');
    await reconcileWithRace(async (db) => {
      await run(db, 'UPDATE scan_gates SET prev_scan_id = ? WHERE pass_id = ?', [id, pass.id]);
    });
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

  it('quarantines pass metadata recorded after the recovery probe', async () => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await reconcileWithRace(async (db) => {
      await run(db, 'UPDATE scans SET pass_id = ? WHERE id = ?', [pass.id, id]);
    });
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
    expect(await reopenScan(kit.env.DB, id, kit.clock.now())).toBeNull();
  });

  it('does not touch a gate or completed scan if the claim finishes after the probe', async () => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await gate(pass.id, id);
    await reconcileWithRace(async (db) => {
      await run(db, "UPDATE scans SET state = 'done', outcome = 'ok' WHERE id = ?", [id]);
    });
    expect(
      await first(kit.env.DB, 'SELECT state, outcome, reason FROM scans WHERE id = ?', [id]),
    ).toEqual({ state: 'done', outcome: 'ok', reason: null });
    expect(
      await first(kit.env.DB, 'SELECT last_scan_id FROM scan_gates WHERE pass_id = ?', [pass.id]),
    ).toEqual({ last_scan_id: id });
    expect(
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toHaveLength(0);
  });

  it('preserves a gate when another recovery has already quarantined the claim', async () => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await gate(pass.id, id);
    await reconcileWithRace(async (db) => {
      await run(db, "UPDATE scans SET state = 'failed', reason = 'stale' WHERE id = ?", [id]);
    });
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
    expect(
      await first(kit.env.DB, 'SELECT last_scan_id FROM scan_gates WHERE pass_id = ?', [pass.id]),
    ).toEqual({ last_scan_id: id });
    expect(await reopenScan(kit.env.DB, id, kit.clock.now())).toBeNull();
  });

  it('does not release a gate belonging to a different pending claim generation', async () => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await gate(pass.id, id);
    await reconcileWithRace(async (db) => {
      await run(db, 'UPDATE scans SET at = ? WHERE id = ?', [kit.clock.now(), id]);
    });
    expect(
      await first(kit.env.DB, 'SELECT state, reason, at FROM scans WHERE id = ?', [id]),
    ).toEqual({ state: 'pending', reason: null, at: kit.clock.now() });
    expect(
      await first(kit.env.DB, 'SELECT last_scan_id FROM scan_gates WHERE pass_id = ?', [pass.id]),
    ).toEqual({ last_scan_id: id });
  });

  it('does not fail a pristine claim reopened after the recovery probe', async () => {
    const id = await pending(null, 120_000);
    await reconcileWithRace(async (db) => {
      await run(db, "UPDATE scans SET state = 'failed' WHERE id = ?", [id]);
      expect(await reopenScan(db, id, kit.clock.now())).toBe(kit.clock.now());
    });
    expect(
      await first(kit.env.DB, 'SELECT state, reason, at FROM scans WHERE id = ?', [id]),
    ).toEqual({ state: 'pending', reason: null, at: kit.clock.now() });
  });

  it('quarantines durable gate intent even if it is set after the recovery probe', async () => {
    const id = await pending(null, 120_000);
    const at = kit.clock.now() - 120_000;
    expect((await markScanEffectIntentStmt(kit.env.DB, id, at + 1).all()).results).toHaveLength(0);
    await reconcileWithRace(async (db) => {
      expect((await markScanEffectIntentStmt(db, id, at).all()).results).toHaveLength(1);
      expect((await releaseClaimStmt(db, id, at).all()).results).toHaveLength(0);
    });
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
    expect(await reopenScan(kit.env.DB, id, kit.clock.now())).toBeNull();
    expect(
      await all(
        kit.env.DB,
        'SELECT pass_id FROM scan_gates WHERE last_scan_id = ? OR prev_scan_id = ?',
        [id, id],
      ),
    ).toHaveLength(0);
  });
}

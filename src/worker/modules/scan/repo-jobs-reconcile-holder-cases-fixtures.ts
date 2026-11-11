import { expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { reconcileScans } from './jobs.ts';
import { gate, kit, pending, reconcileWithRace, scanners, tpl } from './repo-jobs-test-fixtures.ts';
import { reopenScan } from './repo-scans.ts';
import { codeOf, key } from './test-kit.ts';

export function registerReconcileHolderCases() {
  it('quarantines ambiguous claims without finalizing or recording a ledger', async () => {
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
    for (const id of [wonId, lostId, neverId]) {
      expect(
        await first(
          kit.env.DB,
          'SELECT state, outcome, reason, pass_version FROM scans WHERE id = ?',
          [id],
        ),
      ).toEqual({ state: 'failed', outcome: null, reason: 'stale', pass_version: null });
    }
    expect(await first(kit.env.DB, 'SELECT state FROM scans WHERE id = ?', [young])).toEqual({
      state: 'pending',
    });
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id = ?', [won.id]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT last_scan_id FROM scan_gates WHERE pass_id = ?', [lost.id]),
    ).toEqual({ last_scan_id: 'someone-else' });
    await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    for (const pass of [won, lost, never]) {
      expect(
        await all(
          kit.env.DB,
          "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'",
          [pass.id],
        ),
      ).toHaveLength(0);
    }
  });

  it('restores a proven previous gate holder and quarantines the interrupted claim', async () => {
    const pass = await kit.scanPass(tpl);
    const response = await kit.post(scanners.live.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
    });
    expect(response.status).toBe(200);
    const prior = (await response.json()) as ScanOutcome;
    expect(prior.kind).toBe('ok');
    if (!prior.scanId) throw new Error('Missing original scan');
    const id = await pending(pass.id, 120_000, 'add');
    await run(
      kit.env.DB,
      `UPDATE scan_gates SET prev_state = state, prev_last_at = last_at,
      prev_scan_id = last_scan_id, last_scan_id = ?, state = 'used', count = count + 1,
      last_at = last_at + 1 WHERE pass_id = ?`,
      [id, pass.id],
    );
    await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
    expect(
      await first(
        kit.env.DB,
        'SELECT state, last_scan_id, count FROM scan_gates WHERE pass_id = ?',
        [pass.id],
      ),
    ).toEqual({
      state: 'in',
      last_scan_id: prior.scanId,
      count: 1,
    });
  });

  it.each([
    'pending',
    'failed',
    'missing',
    'undone',
    'other pass',
    'other action',
    'fake undo',
  ] as const)('does not restore an unproven previous holder: %s', async (change) => {
    const pass = await kit.scanPass(tpl);
    const priorPass = change === 'other pass' ? await kit.scanPass(tpl) : pass;
    const previous = change === 'missing' ? 'missing-scan' : await pending(priorPass.id, 120_000);
    if (change === 'failed')
      await run(kit.env.DB, "UPDATE scans SET state = 'failed', reason = 'stale' WHERE id = ?", [
        previous,
      ]);
    else if (change !== 'pending' && change !== 'missing')
      await run(
        kit.env.DB,
        `UPDATE scans SET state = 'done', outcome = 'ok',
          undone_by = ?, action_id = ?, action_kind = ? WHERE id = ?`,
        [
          change === 'undone' ? 'undo-scan' : null,
          change === 'other action' ? 'other' : 'check_in',
          change === 'fake undo' ? 'undo' : 'check_in',
          previous,
        ],
      );
    const id = await pending(null, 120_000);
    await gate(pass.id, id);
    await run(
      kit.env.DB,
      `UPDATE scan_gates SET prev_state = 'in', prev_last_at = 1,
        prev_scan_id = ?, state = 'used', count = 2 WHERE pass_id = ?`,
      [previous, pass.id],
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
    if (change === 'pending')
      expect(
        await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [previous]),
      ).toEqual({ state: 'failed', reason: 'stale' });
  });

  it.each(['pending', 'failed', 'failed with reason'] as const)(
    'quarantines a referenced %s prior claim even when cron would not select it',
    async (state) => {
      const pass = await kit.scanPass(tpl);
      const previous = await pending(null, 5_000);
      if (state !== 'pending')
        await run(kit.env.DB, "UPDATE scans SET state = 'failed', reason = ? WHERE id = ?", [
          state === 'failed with reason' ? 'legacy' : null,
          previous,
        ]);
      const id = await pending(null, 120_000);
      await gate(pass.id, id);
      await run(
        kit.env.DB,
        `UPDATE scan_gates SET prev_state = 'in', prev_last_at = 1,
        prev_scan_id = ?, state = 'used', count = 2 WHERE pass_id = ?`,
        [previous, pass.id],
      );
      const held = await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]);
      await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
      for (const scanId of [previous, id])
        expect(
          await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [scanId]),
        ).toEqual({ state: 'failed', reason: 'stale' });
      expect(
        await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]),
      ).toEqual(held);
    },
  );

  it('does not quarantine a previous scan whose pass does not match the gate', async () => {
    const pass = await kit.scanPass(tpl);
    const other = await kit.scanPass(tpl);
    const previous = await pending(other.id, 5_000);
    const id = await pending(null, 120_000);
    await gate(pass.id, id);
    await run(
      kit.env.DB,
      `UPDATE scan_gates SET prev_state = 'in', prev_last_at = 1,
      prev_scan_id = ?, state = 'used', count = 2 WHERE pass_id = ?`,
      [previous, pass.id],
    );
    const held = await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]);
    await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    expect(
      await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [previous]),
    ).toEqual({ state: 'pending', reason: null });
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
    expect(
      await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]),
    ).toEqual(held);
  });

  it('does not quarantine a newer generation of the observed previous claim', async () => {
    const pass = await kit.scanPass(tpl);
    const previous = await pending(null, 5_000);
    const id = await pending(null, 120_000);
    await gate(pass.id, id);
    await run(
      kit.env.DB,
      `UPDATE scan_gates SET prev_state = 'in', prev_last_at = 1,
      prev_scan_id = ?, state = 'used', count = 2 WHERE pass_id = ?`,
      [previous, pass.id],
    );
    const held = await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]);
    await reconcileWithRace(async (db) => {
      await run(db, 'UPDATE scans SET at = ? WHERE id = ?', [kit.clock.now(), previous]);
    });
    expect(
      await first(kit.env.DB, 'SELECT state, reason, at FROM scans WHERE id = ?', [previous]),
    ).toEqual({ state: 'pending', reason: null, at: kit.clock.now() });
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
    expect(
      await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]),
    ).toEqual(held);
  });

  it('rechecks the previous holder in the same transaction as restoring the gate', async () => {
    const pass = await kit.scanPass(tpl);
    const previous = await pending(pass.id, 120_000);
    await run(kit.env.DB, "UPDATE scans SET state = 'done', outcome = 'ok' WHERE id = ?", [
      previous,
    ]);
    const id = await pending(null, 120_000);
    await gate(pass.id, id);
    await run(
      kit.env.DB,
      `UPDATE scan_gates SET prev_state = 'in', prev_last_at = 1,
      prev_scan_id = ?, state = 'used', count = 2 WHERE pass_id = ?`,
      [previous, pass.id],
    );
    const held = await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]);
    await reconcileWithRace(async (db) => {
      await run(db, "UPDATE scans SET state = 'failed', reason = 'stale' WHERE id = ?", [previous]);
    });
    expect(
      await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]),
    ).toEqual(held);
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
  });

  it('can restore a proven undo holder even when the prior gate count was zero', async () => {
    const scanner = await kit.scanner({
      templateIds: [tpl],
      settings: { checkIn: { mode: 'in_out' }, direction: 'both' },
    });
    const pass = await kit.scanPass(tpl);
    const admitted = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
    });
    const firstScan = (await admitted.json()) as ScanOutcome;
    expect(firstScan.kind).toBe('ok');
    if (!firstScan.scanId) throw new Error('Missing original scan');
    const undone = await kit.post(scanner.headers, `/scans/${firstScan.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(undone.status).toBe(200);
    const undoScan = (await undone.json()) as ScanOutcome;
    expect(undoScan.kind).toBe('ok');
    const before = await first(
      kit.env.DB,
      'SELECT state, count, last_at, last_scan_id FROM scan_gates WHERE pass_id = ?',
      [pass.id],
    );
    expect(before).toMatchObject({ state: 'undone', count: 0, last_scan_id: undoScan.scanId });
    const id = await pending(null, 120_000);
    await run(
      kit.env.DB,
      `UPDATE scan_gates SET prev_state = state, prev_last_at = last_at,
      prev_scan_id = last_scan_id, state = 'in', count = count + 1, last_at = last_at + 1,
      last_scan_id = ? WHERE pass_id = ?`,
      [id, pass.id],
    );
    await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    expect(
      await first(
        kit.env.DB,
        'SELECT state, count, last_at, last_scan_id FROM scan_gates WHERE pass_id = ?',
        [pass.id],
      ),
    ).toEqual(before);
    expect(await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [id])).toEqual({
      state: 'failed',
      reason: 'stale',
    });
    expect(
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toHaveLength(2);
  });

  it('finds every gate even when the pending claim has no pass or action', async () => {
    const pass = await kit.scanPass(tpl);
    const id = await pending(null, 120_000);
    await gate(pass.id, id);
    await gate(pass.id, id, 'event:other');
    await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    expect(
      await first(kit.env.DB, 'SELECT state, reason, pass_id, action_id FROM scans WHERE id = ?', [
        id,
      ]),
    ).toEqual({ state: 'failed', reason: 'stale', pass_id: null, action_id: null });
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
    expect(
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toHaveLength(0);
    expect(await reopenScan(kit.env.DB, id, kit.clock.now())).toBeNull();
  });
}

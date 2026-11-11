import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { expectNoUndo, kit, raceBatch, scenario } from './repo-undo-authority-test-fixtures.ts';
import { hashPin } from './staff-pin.ts';
import { key } from './test-kit.ts';
import { undo } from './undo.ts';

const approvalRead = 'FROM scan_staff WHERE id = ? AND org_id = ?';

describe('undo commit authority', () => {
  it.each(['role', 'disabled', 'pin', 'generation'] as const)(
    'the approving manager %s changes while the undo commits',
    async (change) => {
      const s = await scenario();
      const manager = await kit.staff('manager');
      const rotatedHash = await hashPin(kit.env, manager.id, '654321');
      kit.clock.advance(11 * 60_000);
      const undoKey = key();
      const race = raceBatch('UPDATE scan_gates SET state', (db) =>
        run(
          db,
          change === 'role'
            ? "UPDATE scan_staff SET role='door' WHERE id=?"
            : change === 'disabled'
              ? 'UPDATE scan_staff SET disabled_at=1 WHERE id=?'
              : change === 'pin'
                ? 'UPDATE scan_staff SET pin_hash=? WHERE id=?'
                : 'UPDATE scan_staff SET updated_at=updated_at+1 WHERE id=?',
          change === 'pin' ? [rotatedHash, manager.id] : [manager.id],
        ),
      );
      const result = undo(race.ctx, s.actor, s.targetId, {
        idempotencyKey: undoKey,
        approval: { staffId: manager.id, pin: manager.pin },
      });
      // `updated_at` is a timestamp, not authority: only role, disabled and PIN refuse.
      if (change === 'generation') {
        expect((await result).outcome).toMatchObject({ kind: 'ok', replay: false });
        expect(race.raced()).toBe(true);
        return;
      }
      await expect(result).rejects.toMatchObject({ status: 409, code: 'SCAN_STAFF_CHANGED' });
      expect(race.raced()).toBe(true);
      await expectNoUndo(s, undoKey);
    },
  );

  it('refuses a manager disabled and re-enabled between verification and commit', async () => {
    const s = await scenario();
    const manager = await kit.staff('manager');
    kit.clock.advance(11 * 60_000);
    const undoKey = key();
    const race = raceBatch('UPDATE scan_gates SET state', async (db) => {
      await run(db, 'UPDATE scan_staff SET disabled_at=1 WHERE id=?', [manager.id]);
      await run(db, 'UPDATE scan_staff SET disabled_at=NULL WHERE id=?', [manager.id]);
    });
    await expect(
      undo(race.ctx, s.actor, s.targetId, {
        idempotencyKey: undoKey,
        approval: { staffId: manager.id, pin: manager.pin },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'SCAN_STAFF_CHANGED' });
    expect(race.raced()).toBe(true);
    await expectNoUndo(s, undoKey);
  });

  it('undoes when the pass changes during approval verification', async () => {
    const s = await scenario();
    const manager = await kit.staff('manager');
    kit.clock.advance(11 * 60_000);
    const race = raceBatch(approvalRead, (db) =>
      run(db, 'UPDATE passes SET link_generation=link_generation+1 WHERE id=?', [s.pass.id]),
    );
    const result = await undo(race.ctx, s.actor, s.targetId, {
      idempotencyKey: key(),
      approval: { staffId: manager.id, pin: manager.pin },
    });
    expect(race.raced()).toBe(true);
    expect(result.outcome).toMatchObject({ kind: 'ok', replay: false });
  });

  it('records the manager and PIN revision actually verified after a rotation', async () => {
    const s = await scenario();
    const manager = await kit.staff('manager');
    const newPin = '654321';
    const newHash = await hashPin(kit.env, manager.id, newPin);
    const before = await first<{ updated_at: number }>(
      kit.env.DB,
      'SELECT updated_at FROM scan_staff WHERE id=?',
      [manager.id],
    );
    if (!before) throw new Error('Missing manager');
    kit.clock.advance(11 * 60_000);
    const req = { idempotencyKey: key(), approval: { staffId: manager.id, pin: newPin } };
    const race = raceBatch(approvalRead, (db) =>
      run(db, 'UPDATE scan_staff SET pin_hash=?,updated_at=updated_at+1 WHERE id=?', [
        newHash,
        manager.id,
      ]),
    );
    const result = await undo(race.ctx, s.actor, s.targetId, req);
    expect(race.raced()).toBe(true);
    expect(result.outcome).toMatchObject({ kind: 'ok', replay: false });
    expect(
      await first(kit.env.DB, 'SELECT pin_hash,updated_at FROM scan_staff WHERE id=?', [
        manager.id,
      ]),
    ).toEqual({ pin_hash: newHash, updated_at: before.updated_at + 1 });
    expect(
      await first(kit.env.DB, 'SELECT approved_by FROM scans WHERE id=?', [result.outcome.scanId]),
    ).toEqual({ approved_by: manager.id });
    const event = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id=? AND kind='scan.undone'",
      [s.pass.id],
    );
    if (!event) throw new Error('Missing undo event');
    expect(JSON.parse(event.data)).toMatchObject({ approvedBy: manager.id });
    expect(event.data).not.toContain(JSON.stringify(newPin));
    expect(event.data).not.toContain(newHash);
    expect((await undo(kit.ctx, s.actor, s.targetId, req)).outcome).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: result.outcome.scanId,
    });
  });

  it.each(['role', 'disabled', 'pin'] as const)(
    'rejects a manager whose %s changes before approval verification',
    async (change) => {
      const s = await scenario();
      const manager = await kit.staff('manager');
      const rotatedHash = await hashPin(kit.env, manager.id, '654321');
      kit.clock.advance(11 * 60_000);
      const undoKey = key();
      const race = raceBatch(approvalRead, (db) =>
        run(
          db,
          change === 'role'
            ? "UPDATE scan_staff SET role='door' WHERE id=?"
            : change === 'disabled'
              ? 'UPDATE scan_staff SET disabled_at=1 WHERE id=?'
              : 'UPDATE scan_staff SET pin_hash=?,updated_at=updated_at+1 WHERE id=?',
          change === 'pin' ? [rotatedHash, manager.id] : [manager.id],
        ),
      );
      await expect(
        undo(race.ctx, s.actor, s.targetId, {
          idempotencyKey: undoKey,
          approval: { staffId: manager.id, pin: manager.pin },
        }),
      ).rejects.toMatchObject({ status: 400, code: 'PIN_INVALID' });
      expect(race.raced()).toBe(true);
      await expectNoUndo(s, undoKey);
    },
  );

  it('accepts an unchanged manager approval', async () => {
    const s = await scenario();
    const manager = await kit.staff('manager');
    kit.clock.advance(11 * 60_000);
    const req = { idempotencyKey: key(), approval: { staffId: manager.id, pin: manager.pin } };
    const { outcome: result } = await undo(kit.ctx, s.actor, s.targetId, req);
    expect(result).toMatchObject({ kind: 'ok', replay: false });
    expect(
      await first(kit.env.DB, 'SELECT approved_by FROM scans WHERE id=?', [result.scanId]),
    ).toEqual({ approved_by: manager.id });
    expect((await undo(kit.ctx, s.actor, s.targetId, req)).outcome).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: result.scanId,
    });
  });

  it('replays against the recorded manager, not a different request approval', async () => {
    const s = await scenario();
    const manager = await kit.staff('manager');
    const other = await kit.staff('manager');
    kit.clock.advance(11 * 60_000);
    const req = { idempotencyKey: key(), approval: { staffId: manager.id, pin: manager.pin } };
    const result = await undo(kit.ctx, s.actor, s.targetId, req);
    await run(kit.env.DB, 'UPDATE scan_staff SET disabled_at=1 WHERE id=?', [other.id]);
    const replay = await undo(kit.ctx, s.actor, s.targetId, {
      ...req,
      approval: { staffId: other.id, pin: other.pin },
    });
    expect(replay.outcome).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: result.outcome.scanId,
    });
    expect(
      await first(kit.env.DB, 'SELECT approved_by FROM scans WHERE id=?', [result.outcome.scanId]),
    ).toEqual({ approved_by: manager.id });
  });

  it.each(['role', 'disabled', 'generation'] as const)(
    'replays after the recorded manager %s changed: a retry checks only its key',
    async (change) => {
      const s = await scenario();
      const manager = await kit.staff('manager');
      kit.clock.advance(11 * 60_000);
      const req = { idempotencyKey: key(), approval: { staffId: manager.id, pin: manager.pin } };
      const result = await undo(kit.ctx, s.actor, s.targetId, req);
      await run(
        kit.env.DB,
        change === 'role'
          ? "UPDATE scan_staff SET role='door' WHERE id=?"
          : change === 'disabled'
            ? 'UPDATE scan_staff SET disabled_at=1 WHERE id=?'
            : 'UPDATE scan_staff SET updated_at=updated_at+1 WHERE id=?',
        [manager.id],
      );
      expect((await undo(kit.ctx, s.actor, s.targetId, req)).outcome).toMatchObject({
        kind: 'ok',
        replay: true,
        scanId: result.outcome.scanId,
      });
      expect(
        await first(
          kit.env.DB,
          "SELECT count(*) AS n FROM audit_log WHERE target_id=? AND action='scan.undo'",
          [s.targetId],
        ),
      ).toEqual({ n: 1 });
    },
  );
});

import { describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { run } from '../../platform/db.ts';
import { expectNoUndo, kit, raceBatch, scenario } from './repo-undo-authority-test-fixtures.ts';
import { key } from './test-kit.ts';
import { undo } from './undo.ts';

describe('undo during a credential transfer', () => {
  it('answers the masked not found when a transfer starts before the undo commits', async () => {
    const s = await scenario();
    const undoKey = key();
    const race = raceBatch('UPDATE scan_gates SET state', (db) =>
      stagePendingCredentialTransfer(db, s.pass.id, {
        id: kit.fx.ids.id(),
        token: kit.fx.ids.token(),
        now: kit.clock.now(),
      }),
    );
    await expect(
      undo(race.ctx, s.actor, s.targetId, { idempotencyKey: undoKey }),
    ).rejects.toMatchObject({ status: 404, code: 'SCAN_NOT_FOUND' });
    expect(race.raced()).toBe(true);
    await expectNoUndo(s, undoKey);
  });

  it('undoes when the pass moves without a pending transfer', async () => {
    const s = await scenario();
    const race = raceBatch('UPDATE scan_gates SET state', (db) =>
      run(db, 'UPDATE passes SET link_generation=link_generation+1 WHERE id=?', [s.pass.id]),
    );
    expect(
      (await undo(race.ctx, s.actor, s.targetId, { idempotencyKey: key() })).outcome,
    ).toMatchObject({ kind: 'ok', replay: false });
    expect(race.raced()).toBe(true);
  });
});

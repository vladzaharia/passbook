/* istanbul ignore file -- @preserve */
import { expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import {
  accepted,
  action,
  effects,
  kit,
  managerTemplate,
  template,
  tracking,
  undoResponse,
} from './repo-commit-fence-test-fixtures.ts';
import { key } from './test-kit.ts';

export function registerCommitFenceControls() {
  it('allows a scanner check-in and undo, including presence, ledger and audit', async () => {
    const pass = await kit.scanPass(template);
    const scanner = await kit.scanner({ templateIds: [template], settings: tracking });
    const scanId = await accepted(scanner, pass);
    const entered = await effects(kit.env.DB, pass.id);
    expect(entered.gates).toHaveLength(1);
    expect(entered.presence).toHaveLength(1);
    expect(entered.ledger).toMatchObject([{ kind: 'scan.checked_in' }]);
    const response = await undoResponse(scanner, scanId, key());
    expect(response.status).toBe(200);
    const undone = (await response.json()) as ScanOutcome;
    expect(undone).toMatchObject({ kind: 'ok', replay: false });
    expect(await first(kit.env.DB, 'SELECT undone_by FROM scans WHERE id = ?', [scanId])).toEqual({
      undone_by: undone.scanId,
    });
    expect(
      await first(kit.env.DB, 'SELECT action_kind, undoes FROM scans WHERE id = ?', [
        undone.scanId ?? '',
      ]),
    ).toEqual({ action_kind: 'undo', undoes: scanId });
    expect(
      await all(
        kit.env.DB,
        "SELECT kind FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%' ORDER BY kind",
        [pass.id],
      ),
    ).toEqual([{ kind: 'scan.checked_in' }, { kind: 'scan.undone' }]);
    expect(
      await all(kit.env.DB, 'SELECT * FROM scan_presence WHERE pass_id = ?', [pass.id]),
    ).toEqual([]);
    expect(
      await all(
        kit.env.DB,
        "SELECT action FROM audit_log WHERE target_type = 'scan' AND target_id = ? AND action = 'scan.undo'",
        [scanId],
      ),
    ).toEqual([{ action: 'scan.undo' }]);
  });

  it('allows an active signed-in Manager to perform a Manager action', async () => {
    const manager = await kit.staff('manager');
    const pass = await kit.scanPass(managerTemplate);
    const scanner = await kit.scanner({
      templateIds: [managerTemplate],
      staffId: manager.id,
      settings: { ...tracking, staffSignIn: true },
    });
    const scanId = await accepted(scanner, pass);
    expect(
      await first(kit.env.DB, 'SELECT staff_id, approved_by FROM scans WHERE id = ?', [scanId]),
    ).toEqual({ staff_id: manager.id, approved_by: null });
  });

  it('accepts and records a live Manager PIN approval for a door scanner', async () => {
    const manager = await kit.staff('manager');
    const pass = await kit.scanPass(managerTemplate);
    const scanner = await kit.scanner({ templateIds: [managerTemplate], settings: tracking });
    const scanId = await accepted(scanner, pass, {
      approval: { staffId: manager.id, pin: manager.pin },
    });
    expect(await first(kit.env.DB, 'SELECT approved_by FROM scans WHERE id = ?', [scanId])).toEqual(
      { approved_by: manager.id },
    );
    const written = await effects(kit.env.DB, pass.id);
    expect(written.gates).toHaveLength(1);
    expect(written.presence).toHaveLength(1);
    expect(written.ledger).toMatchObject([{ kind: 'scan.checked_in' }]);
  });

  it('still records an unchanged known voided-pass refusal', async () => {
    const pass = await kit.scanPass(template);
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    const scanner = await kit.scanner({ templateIds: [template], settings: tracking });
    const response = await action(scanner, pass, key());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'refused', reason: 'voided' });
    expect(
      await all(
        kit.env.DB,
        "SELECT kind FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'",
        [pass.id],
      ),
    ).toEqual([{ kind: 'scan.rejected' }]);
  });
}

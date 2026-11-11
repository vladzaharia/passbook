/* istanbul ignore file -- @preserve */
import { expect, it } from 'vitest';
import { runOne } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, run } from '../../platform/db.ts';
import {
  accepted,
  action,
  atCommit,
  expectFencedAction,
  kit,
  pending,
  template,
  tracking,
} from './repo-commit-fence-test-fixtures.ts';
import { key } from './test-kit.ts';

export function registerCommitFenceRefusals() {
  it('records a known voided-pass refusal when the holder changes before it is recorded', async () => {
    const pass = await kit.scanPass(template);
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    const scanner = await kit.scanner({ templateIds: [template], settings: tracking });
    await expectFencedAction(
      scanner,
      pass,
      async (db) => {
        await runOne(db, 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?', [
          pass.id,
        ]);
      },
      // The holder is content, not authority: the voided-pass refusal is recorded.
      { kind: 'stop', code: 'admitted' },
    );
  });

  it('does not record a known-pass refusal when the scanner is revoked before the stop commits', async () => {
    const pass = await kit.scanPass(template);
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
    const scanner = await kit.scanner({ templateIds: [template] });
    await expectFencedAction(
      scanner,
      pass,
      async (db) => {
        await runOne(db, 'UPDATE scanners SET revoked_at=?, updated_at=updated_at+1 WHERE id=?', [
          kit.clock.now(),
          scanner.id,
        ]);
      },
      { kind: 'stop', code: 'SCANNER_REPAIR' },
    );
  });

  // Gate loss is decided inside the one commit grant now (no second batch); a version bump is
  // content, so the already-done heads-up is recorded.
  it('records an already-done heads-up when the pass version changes before the commit', async () => {
    const pass = await kit.scanPass(template);
    const scanner = await kit.scanner({ templateIds: [template] });
    await accepted(scanner, pass);
    await expectFencedAction(
      scanner,
      pass,
      async (db) => {
        await runOne(db, 'UPDATE passes SET version=version+1 WHERE id=?', [pass.id]);
      },
      { kind: 'gate-loser', code: 'admitted' },
    );
  });

  it('finishes through a matching gate that names this scan when only content changes', async () => {
    const pass = await kit.scanPass(template);
    // Direction enables admission planning without changing the action's once-only gate rule.
    const scanner = await kit.scanner({ templateIds: [template], settings: { direction: 'both' } });
    await expectFencedAction(
      scanner,
      pass,
      async (db, scanId) => {
        await run(
          db,
          `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
         VALUES (?, 'check_in', '', ?, 'live', ?, 'check_in', 'in', 1, ?, ?, ?)`,
          [pass.id, kit.org.id, template, kit.clock.now(), kit.clock.now(), scanId],
        );
        await runOne(db, 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?', [
          pass.id,
        ]);
      },
      // A gate row that names this very scan is its own earlier effect, and a link generation is content.
      { code: 'admitted' },
    );
  });

  it('counts a pre-existing gate that names this scan once, not as a second win', async () => {
    const pass = await kit.scanPass(template);
    const scanner = await kit.scanner({ templateIds: [template], settings: { direction: 'both' } });
    const idempotencyKey = key();
    let beforeGate: unknown;
    const response = await atCommit(
      'check-in',
      async (db) => {
        const scanId = await pending(db, scanner, idempotencyKey);
        await run(
          db,
          `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
         VALUES (?, 'check_in', '', ?, 'live', ?, 'check_in', 'in', 1, ?, ?, ?)`,
          [pass.id, kit.org.id, template, kit.clock.now(), kit.clock.now(), scanId],
        );
      },
      () => action(scanner, pass, idempotencyKey),
    );
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ScanOutcome;
    expect(outcome).toMatchObject({ kind: 'ok' });
    expect(
      await all(kit.env.DB, 'SELECT count, last_scan_id FROM scan_gates WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toEqual([{ count: 1, last_scan_id: outcome.scanId }]);
    expect(
      await all(
        kit.env.DB,
        "SELECT id FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_in'",
        [pass.id],
      ),
    ).toHaveLength(1);
  });
}

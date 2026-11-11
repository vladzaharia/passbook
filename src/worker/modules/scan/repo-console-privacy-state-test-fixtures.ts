import { all, first, run } from '../../platform/db.ts';
import type { Pass } from '../passes/repo.ts';
import { kit } from './console-privacy-test-fixtures.ts';

export async function recordWalletVersion(id: string) {
  await run(
    kit.env.DB,
    `INSERT INTO pass_versions
    (pass_id,version,template_version,personalization,pass_json,cause,created_at)
    SELECT p.id,p.version,p.template_version,p.personalization,
      json_set(tv.pass_json, '$.serialNumber', p.serial, '$.passTypeIdentifier', si.pass_type_identifier,
        '$.teamIdentifier', si.team_identifier), 'create', ?
    FROM passes p JOIN template_versions tv ON tv.template_id=p.template_id AND tv.version=p.template_version
      JOIN signing_identities si ON si.id=p.identity_id
    WHERE p.id=?`,
    [kit.clock.now(), id],
  );
}

export async function replayEffects(pass: Pass) {
  return {
    pass: await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]),
    gates: await all(
      kit.env.DB,
      'SELECT * FROM scan_gates WHERE pass_id = ? ORDER BY action_id, scope',
      [pass.id],
    ),
    scans: await all(kit.env.DB, 'SELECT * FROM scans WHERE pass_id = ? ORDER BY id', [pass.id]),
    ledger: await all(
      kit.env.DB,
      "SELECT * FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%' ORDER BY id",
      [pass.id],
    ),
    presence: await all(
      kit.env.DB,
      'SELECT * FROM scan_presence WHERE pass_id = ? ORDER BY scope',
      [pass.id],
    ),
    audit: await all(
      kit.env.DB,
      "SELECT * FROM audit_log WHERE org_id = ? AND action LIKE 'scan.%' ORDER BY id",
      [pass.orgId],
    ),
  };
}

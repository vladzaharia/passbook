import type { PassJson } from '../../../passkit/types.ts';
import { first, run } from '../../platform/db.ts';

export function clearPreviewAudit(db: D1Database) {
  return run(db, 'DELETE FROM audit_log');
}

export function previewPassIdentity(db: D1Database, passId: string) {
  return first<{ pass_type_identifier: string; team_identifier: string }>(
    db,
    `SELECT si.pass_type_identifier, si.team_identifier FROM passes p
       JOIN signing_identities si ON si.id = p.identity_id WHERE p.id = ?`,
    [passId],
  );
}

export async function updatePreviewPass(
  db: D1Database,
  passId: string,
  title: string,
  subtitle: string,
  externalId: string,
  snapshot: PassJson,
) {
  await run(
    db,
    'UPDATE passes SET display_title = ?, display_subtitle = ?, external_id = ? WHERE id = ?',
    [title, subtitle, externalId, passId],
  );
  await run(db, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ? AND version = 1', [
    JSON.stringify(snapshot),
    passId,
  ]);
}

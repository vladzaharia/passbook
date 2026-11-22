import { run } from '../../platform/db.ts';

/**
 * The blueprint kit builds a pass with the env's signing identity but stores another identity row, so the
 * scanner refuses the pass JSON. This gives the pass's stored JSON its own identity row's ids.
 */
export async function alignPassIdentity(db: D1Database, passId: string): Promise<void> {
  await run(
    db,
    `UPDATE pass_versions SET pass_json = (
       SELECT json_set(pass_versions.pass_json, '$.passTypeIdentifier', si.pass_type_identifier,
         '$.teamIdentifier', si.team_identifier)
       FROM passes p JOIN signing_identities si ON si.id = p.identity_id WHERE p.id = pass_versions.pass_id
     ) WHERE pass_id = ? AND pass_json IS NOT NULL`,
    [passId],
  );
}

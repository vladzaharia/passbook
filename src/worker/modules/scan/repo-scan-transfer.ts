import { first } from '../../platform/db.ts';

/** The credential moved since this scan: a transfer is pending, or the generation its event recorded is not the pass's. */
export async function holderMoved(
  db: D1Database,
  passId: string,
  scanId: string,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 AS n FROM passes p WHERE p.id = ? AND (
         EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')
         OR EXISTS (SELECT 1 FROM pass_events e WHERE e.pass_id = p.id
           AND CASE WHEN json_valid(e.data) THEN json_extract(e.data, '$.scanId') = ?
             AND json_type(e.data, '$.authority.credentialGeneration') = 'integer'
             AND json_extract(e.data, '$.authority.credentialGeneration') <> p.credential_generation
             ELSE 0 END))`,
      [passId, scanId],
    )) !== null
  );
}

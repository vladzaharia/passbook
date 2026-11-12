import { first } from '../../platform/db.ts';

export function stagedCredentialTransfer(db: D1Database, passId: string) {
  return first<{ credential_generation: number; pending: number }>(
    db,
    `SELECT p.credential_generation, EXISTS(SELECT 1 FROM pass_credential_transfers t
       WHERE t.pass_id = p.id AND t.state = 'pending') AS pending FROM passes p WHERE p.id = ?`,
    [passId],
  );
}

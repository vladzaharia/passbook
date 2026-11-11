import { type SqlValue, stmt } from '../../platform/db.ts';

/**
 * Check the captured authority and pin the keyset once, within the initialization transaction.
 * The singleton is immutable, so later statements do not repeat the commitment.
 */
export function credentialKeysetAuthorityStmt(
  db: D1Database,
  commitment: string,
  guard: { sql: string; params: readonly SqlValue[] },
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END AS authorized,
      CASE WHEN COALESCE((SELECT commitment FROM credential_ref_keyset WHERE id = 1) = ?, 0) THEN 1 ELSE 0 END AS matches`,
    [...guard.params, commitment],
  );
}

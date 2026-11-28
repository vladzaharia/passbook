import { run } from '../../platform/db.ts';

/**
 * Ends a CLI token: stamps its session, and the trigger of 0245 revokes the key in the same statement. A token
 * already ended keeps its first time and reason. Returns whether this call ended it.
 */
export async function endCliToken(
  db: D1Database,
  keyId: string,
  reason: string,
  now: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE cli_sessions SET token_revoked_at = ?, token_revoke_reason = ?
     WHERE token_id = ? AND token_revoked_at IS NULL`,
    [now, reason, keyId],
  );
  return changes > 0;
}

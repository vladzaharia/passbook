import { first } from '../../platform/db.ts';
import type { BroadcastRow } from './repo.ts';

/**
 * False when the key that created a broadcast is revoked or expired, or the admin is disabled or
 * no longer an admin. System-made broadcasts (the clearing follow-up) have no creator to check.
 */
export async function creatorIsActive(
  db: D1Database,
  row: Pick<BroadcastRow, 'created_by_type' | 'created_by_id'>,
  now: number,
): Promise<boolean> {
  if (!row.created_by_id) return true;
  if (row.created_by_type === 'api_key') {
    const key = await first<{ one: number }>(
      db,
      `SELECT 1 AS one FROM api_keys WHERE id = ? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
      [row.created_by_id, now],
    );
    return key !== null;
  }
  if (row.created_by_type === 'user') {
    const user = await first<{ one: number }>(
      db,
      `SELECT 1 AS one FROM users WHERE id = ? AND status = 'active'
         AND EXISTS (SELECT 1 FROM json_each(users.last_roles) WHERE value = 'admin')`,
      [row.created_by_id],
    );
    return user !== null;
  }
  return true;
}

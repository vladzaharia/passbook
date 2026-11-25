import { all } from '../../platform/db.ts';
import { DELETE_ACTION } from './repo-grants-reset.ts';

/** When the person's deletes in the last day happened, newest first: the audit rows are the count. */
export const deletesSince = async (
  db: D1Database,
  userId: string,
  since: number,
): Promise<number[]> =>
  (
    await all<{ at: number }>(
      db,
      'SELECT at FROM audit_log WHERE actor_id = ? AND action = ? AND at > ? ORDER BY at DESC',
      [userId, DELETE_ACTION, since],
    )
  ).map((r) => r.at);

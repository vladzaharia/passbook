import { all, run, stmt } from '../../platform/db.ts';
import { COLUMNS, type OperationRow } from './repo.ts';

/** Running rows whose last heartbeat is older than `before`: candidates for a stall check. */
export function runningSilentSince(
  db: D1Database,
  before: number,
  limit: number,
): Promise<OperationRow[]> {
  return all<OperationRow>(
    db,
    `SELECT ${COLUMNS} FROM operations WHERE status = 'running' AND heartbeat_at < ?
     ORDER BY heartbeat_at LIMIT ?`,
    [before, limit],
  );
}

/** A live runner or Workflow: push the heartbeat out. */
export async function bumpHeartbeat(db: D1Database, id: string, now: number): Promise<void> {
  await run(db, `UPDATE operations SET heartbeat_at = ? WHERE id = ? AND status = 'running'`, [
    now,
    id,
  ]);
}

/** The one resend: the lease becomes 0, so a second stall with it still 0 fails the row. */
export async function markResent(
  db: D1Database,
  id: string,
  attempt: number,
  now: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE operations SET lease_until = 0, heartbeat_at = ?
     WHERE id = ? AND attempt = ? AND status = 'running'`,
    [now, id, attempt],
  );
  return changes === 1;
}

/** Ended rows past their expiry. Active rows never expire. */
export async function deleteExpired(db: D1Database, now: number, limit: number): Promise<number> {
  const result = await stmt(
    db,
    `DELETE FROM operations WHERE id IN (
       SELECT id FROM operations
       WHERE expires_at IS NOT NULL AND expires_at <= ? AND status IN ('succeeded', 'failed', 'cancelled')
       LIMIT ?)`,
    [now, limit],
  ).run();
  return result.meta.changes ?? 0;
}

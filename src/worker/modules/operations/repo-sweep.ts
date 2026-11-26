import { all, run, stmt } from '../../platform/db.ts';
import { COLUMNS, type OperationRow } from './repo.ts';

/** Queued and running rows silent since `before` (a queued row's silence runs from its creation): candidates for a stall check. */
export function runningSilentSince(
  db: D1Database,
  before: number,
  limit: number,
): Promise<OperationRow[]> {
  return all<OperationRow>(
    db,
    `SELECT ${COLUMNS} FROM operations
     WHERE status IN ('queued', 'running') AND COALESCE(heartbeat_at, created_at) < ?
     ORDER BY COALESCE(heartbeat_at, created_at) LIMIT ?`,
    [before, limit],
  );
}

/** A live runner or Workflow: push the heartbeat out. */
export async function bumpHeartbeat(db: D1Database, id: string, now: number): Promise<void> {
  await run(
    db,
    `UPDATE operations SET heartbeat_at = ? WHERE id = ? AND status IN ('queued', 'running')`,
    [now, id],
  );
}

/**
 * The one resend: frees the lease and counts it. `seen` is the count the sweep read, so two overlapping sweeps
 * cannot both resend, and a second stall (`resends` already 1) is failed by the caller instead.
 */
export async function markResent(
  db: D1Database,
  id: string,
  attempt: number,
  seen: number,
  now: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE operations SET resends = resends + 1, lease_until = NULL, lease_owner = NULL, heartbeat_at = ?
     WHERE id = ? AND attempt = ? AND resends = ? AND status IN ('queued', 'running')`,
    [now, id, attempt, seen],
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

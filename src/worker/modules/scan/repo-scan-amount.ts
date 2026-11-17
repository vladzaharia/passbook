import type { Mode } from '../../../shared/contracts/common.ts';
import { first } from '../../platform/db.ts';

/** What one scanner has added and taken since `since`: the daily amount cap counts it. */
export async function amountUsedSince(
  db: D1Database,
  scope: { orgId: string; mode: Mode; actorKey: string },
  since: number,
): Promise<number> {
  const row = await first<{ used: number }>(
    db,
    `SELECT COALESCE(SUM(amount), 0) AS used FROM scans
     WHERE org_id = ? AND mode = ? AND actor_key = ? AND action_kind IN ('add', 'take')
       AND outcome = 'ok' AND undone_by IS NULL AND at >= ?`,
    [scope.orgId, scope.mode, scope.actorKey, since],
  );
  return row?.used ?? 0;
}

/**
 * A scan already filled this card since its last redeem, undone or not: the daily push budget's
 * exemption belongs to the first fill of a reward cycle, so fill, undo, fill again is not free.
 */
export async function filledSinceRedeem(
  db: D1Database,
  scope: { orgId: string; passId: string },
  goal: number,
): Promise<boolean> {
  const row = await first<{ n: number }>(
    db,
    `SELECT EXISTS (
       SELECT 1 FROM scans f
       WHERE f.org_id = ? AND f.pass_id = ? AND f.state = 'done' AND f.outcome = 'ok'
         AND f.action_kind = 'add' AND CAST(f.before_value AS REAL) < ?
         AND CAST(f.after_value AS REAL) >= ?
         AND f.at > COALESCE((SELECT MAX(r.at) FROM scans r
           WHERE r.org_id = f.org_id AND r.pass_id = f.pass_id AND r.action_kind = 'take'
             AND r.outcome = 'ok' AND r.undone_by IS NULL), 0)
     ) AS n`,
    [scope.orgId, scope.passId, goal, goal],
  );
  return row?.n === 1;
}

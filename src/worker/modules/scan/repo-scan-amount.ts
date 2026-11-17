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

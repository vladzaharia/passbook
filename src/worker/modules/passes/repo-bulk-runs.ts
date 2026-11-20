import { first } from '../../platform/db.ts';

/** A queued run older than this is treated as dead, so a lost workflow never blocks an org for good. */
const RUN_ACTIVE_MS = 6 * 60 * 60 * 1000;

/** The queued or running rebuild for this org and target, if any. Runs carry no mode; test and live share one. */
export async function activeBulkRun(
  db: D1Database,
  orgId: string,
  targetId: string,
  now: number,
): Promise<string | null> {
  const row = await first<{ instance_id: string }>(
    db,
    `SELECT instance_id FROM workflow_runs
      WHERE kind = 'bulk_reissue' AND org_id = ? AND target_id = ?
        AND status IN ('queued', 'running') AND started_at > ?
      ORDER BY started_at DESC LIMIT 1`,
    [orgId, targetId, now - RUN_ACTIVE_MS],
  );
  return row?.instance_id ?? null;
}

import { all, first } from '../../platform/db.ts';

const KINDS = ['template_import', 'bulk_reissue', 'connection_sync', 'broadcast'] as const;

export interface WorkflowCount {
  kind: string;
  status: string;
  n: number;
}

/**
 * Counts per kind and status since a time; each branch is a range on workflow_runs_kind.
 * Rejected template uploads (IMPORT_INVALID) are the uploader's error, not platform health.
 */
export function workflowCounts(db: D1Database, since: number): Promise<WorkflowCount[]> {
  const sql = KINDS.map(
    () =>
      "SELECT kind, CASE WHEN error_code = 'IMPORT_INVALID' THEN 'rejected' ELSE status END AS status, count(*) AS n FROM workflow_runs WHERE kind = ? AND started_at >= ? GROUP BY kind, 2",
  ).join(' UNION ALL ');
  return all<WorkflowCount>(
    db,
    sql,
    KINDS.flatMap((kind) => [kind, since]),
  );
}

export interface WorkflowRunRow {
  instance_id: string;
  kind: (typeof KINDS)[number];
  org_id: string | null;
  target_id: string | null;
  status: 'queued' | 'running' | 'complete' | 'errored' | 'terminated';
  started_at: number;
  finished_at: number | null;
  error_code: string | null;
}

export function recentWorkflowRuns(db: D1Database, limit: number): Promise<WorkflowRunRow[]> {
  const branch = `SELECT * FROM (SELECT instance_id, kind, org_id, target_id, status, started_at, finished_at, error_code
    FROM workflow_runs WHERE kind = ? ORDER BY started_at DESC LIMIT ?)`;
  return all<WorkflowRunRow>(
    db,
    `${KINDS.map(() => branch).join(' UNION ALL ')} ORDER BY started_at DESC LIMIT ?`,
    [...KINDS.flatMap((kind) => [kind, limit]), limit],
  );
}

/** Latest break-glass sign-in, through the audit_target index. */
export async function lastBreakglassUse(db: D1Database): Promise<number | null> {
  const row = await first<{ at: number }>(
    db,
    `SELECT at FROM audit_log
     WHERE target_type = 'user'
       AND target_id = (SELECT user_id FROM auth_identities WHERE provider = 'breakglass' AND subject = 'breakglass')
       AND action = 'auth.breakglass_used'
     ORDER BY at DESC LIMIT 1`,
  );
  return row?.at ?? null;
}

export interface ConnectionHealthRow {
  health: string;
  enabled: number;
  n: number;
}

/** Connections are few per deployment; this reads the whole (small) table once. */
export function connectionHealthCounts(db: D1Database): Promise<ConnectionHealthRow[]> {
  return all<ConnectionHealthRow>(
    db,
    'SELECT health, enabled, count(*) AS n FROM connections GROUP BY health, enabled',
  );
}

export interface UnhealthyConnection {
  id: string;
  org_id: string;
  name: string;
  health: string;
  consecutive_failures: number;
}

export function unhealthyConnections(
  db: D1Database,
  limit: number,
): Promise<UnhealthyConnection[]> {
  return all<UnhealthyConnection>(
    db,
    `SELECT id, org_id, name, health, consecutive_failures FROM connections
     WHERE enabled = 1 AND health IN ('degraded', 'failing') LIMIT ?`,
    [limit],
  );
}

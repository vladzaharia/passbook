import { all } from '../../platform/db.ts';

const KINDS = ['template_import', 'bulk_reissue', 'connection_sync'] as const;

export interface WorkflowCount {
  kind: string;
  status: string;
  n: number;
}

/** Counts per kind and status since a time; each branch is a range on workflow_runs_kind. */
export function workflowCounts(db: D1Database, since: number): Promise<WorkflowCount[]> {
  const sql = KINDS.map(
    () =>
      'SELECT kind, status, count(*) AS n FROM workflow_runs WHERE kind = ? AND started_at >= ? GROUP BY kind, status',
  ).join(' UNION ALL ');
  return all<WorkflowCount>(
    db,
    sql,
    KINDS.flatMap((kind) => [kind, since]),
  );
}

export interface WorkflowRunRow {
  instance_id: string;
  kind: 'template_import' | 'bulk_reissue' | 'connection_sync';
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

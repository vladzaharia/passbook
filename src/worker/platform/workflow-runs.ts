import { first, run, stmt } from './db.ts';

/** The `workflow_runs` table: every module that starts a workflow records it here. */
export type WorkflowKind = 'template_import' | 'bulk_reissue' | 'connection_sync' | 'broadcast';
export type WorkflowStatus = 'queued' | 'running' | 'complete' | 'errored' | 'terminated';

export interface NewRun {
  instanceId: string;
  kind: WorkflowKind;
  orgId: string | null;
  targetId: string | null;
  now: number;
}

/** The INSERT as a statement, for a batch that also writes the module's own rows. */
export function startRunStmt(db: D1Database, r: NewRun, ignoreDuplicate = false) {
  return stmt(
    db,
    `INSERT ${ignoreDuplicate ? 'OR IGNORE ' : ''}INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at)
     VALUES (?, ?, ?, ?, 'queued', ?)`,
    [r.instanceId, r.kind, r.orgId, r.targetId, r.now],
  );
}

/** False when `ignoreDuplicate` skipped an instance that already has a row. */
export async function startRun(
  db: D1Database,
  r: NewRun,
  options: { ignoreDuplicate?: boolean } = {},
): Promise<boolean> {
  const result = await startRunStmt(db, r, options.ignoreDuplicate).run();
  const changes = result.meta.changes ?? 0;
  return changes === 1;
}

/** Moves a run to a status; terminal statuses stamp `finished_at`. */
export async function finishRun(
  db: D1Database,
  instanceId: string,
  status: WorkflowStatus,
  now: number,
  extra: { errorCode?: string | null; targetId?: string | null } = {},
): Promise<void> {
  const done = status === 'complete' || status === 'errored' || status === 'terminated';
  await run(
    db,
    `UPDATE workflow_runs SET status = ?, finished_at = ?, error_code = ?, target_id = COALESCE(?, target_id)
     WHERE instance_id = ?`,
    [status, done ? now : null, extra.errorCode ?? null, extra.targetId ?? null, instanceId],
  );
}

export async function deleteRun(db: D1Database, instanceId: string): Promise<void> {
  await run(db, 'DELETE FROM workflow_runs WHERE instance_id = ?', [instanceId]);
}

export async function runStartedAt(db: D1Database, instanceId: string): Promise<number | null> {
  const row = await first<{ started_at: number }>(
    db,
    'SELECT started_at FROM workflow_runs WHERE instance_id = ?',
    [instanceId],
  );
  return row?.started_at ?? null;
}

/** Retention: drops runs of one kind that started before `before`. */
export async function deleteRunsBefore(
  db: D1Database,
  kind: string,
  before: number,
): Promise<number> {
  return (
    await run(db, 'DELETE FROM workflow_runs WHERE kind = ? AND started_at < ?', [kind, before])
  ).changes;
}

import { first, run } from '../../platform/db.ts';

// Workflow runs

export async function insertWorkflowRun(
  db: D1Database,
  w: { instanceId: string; orgId: string; connectionId: string; startedAt: number },
): Promise<void> {
  await run(
    db,
    `INSERT OR IGNORE INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at)
     VALUES (?, 'connection_sync', ?, ?, 'queued', ?)`,
    [w.instanceId, w.orgId, w.connectionId, w.startedAt],
  );
}

export async function setWorkflowStatus(
  db: D1Database,
  instanceId: string,
  status: 'running' | 'complete' | 'errored',
  now: number,
  errorCode: string | null = null,
): Promise<void> {
  await run(
    db,
    `UPDATE workflow_runs SET status = ?, error_code = ?, finished_at = ? WHERE instance_id = ?`,
    [status, errorCode, status === 'running' ? null : now, instanceId],
  );
}

export async function workflowStartedAt(
  db: D1Database,
  instanceId: string,
): Promise<number | null> {
  const r = await first<{ started_at: number }>(
    db,
    'SELECT started_at FROM workflow_runs WHERE instance_id = ?',
    [instanceId],
  );
  return r?.started_at ?? null;
}

// Retention

export async function deleteOldRuns(db: D1Database, before: number, keep: number): Promise<number> {
  const old = await run(db, 'DELETE FROM connection_runs WHERE started_at < ?', [before]);
  const excess = await run(
    db,
    `DELETE FROM connection_runs WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY connection_id ORDER BY started_at DESC, id DESC) AS rn
         FROM connection_runs
       ) WHERE rn > ?)`,
    [keep],
  );
  return old.changes + excess.changes;
}

export async function deleteOldWebhookEvents(db: D1Database, before: number): Promise<number> {
  // connection_inbox rows go with their event (ON DELETE CASCADE).
  return (await run(db, 'DELETE FROM webhook_events WHERE received_at < ?', [before])).changes;
}

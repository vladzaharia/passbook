import { deleteInBatches } from '../../platform/batched.ts';
import { first, run } from '../../platform/db.ts';
import { deleteRun, finishRun, startRun } from '../../platform/workflow-runs.ts';

// Workflow runs

export function insertWorkflowRun(
  db: D1Database,
  w: { instanceId: string; orgId: string; connectionId: string; startedAt: number },
): Promise<boolean> {
  return startRun(
    db,
    {
      instanceId: w.instanceId,
      kind: 'connection_sync',
      orgId: w.orgId,
      targetId: w.connectionId,
      now: w.startedAt,
    },
    { ignoreDuplicate: true },
  );
}

export async function deleteWorkflowRun(db: D1Database, instanceId: string): Promise<void> {
  await deleteRun(db, instanceId);
}

export const setWorkflowStatus = (
  db: D1Database,
  instanceId: string,
  status: 'running' | 'complete' | 'errored',
  now: number,
  errorCode: string | null = null,
) => finishRun(db, instanceId, status, now, { errorCode });

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
  const old = { changes: await deleteInBatches(db, 'connection_runs', 'started_at < ?', [before]) };
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

export async function deleteOldWorkflowRuns(db: D1Database, before: number): Promise<number> {
  return (
    await run(db, "DELETE FROM workflow_runs WHERE kind = 'connection_sync' AND started_at < ?", [
      before,
    ])
  ).changes;
}

export async function deleteOldWebhookEvents(db: D1Database, before: number): Promise<number> {
  // connection_inbox rows go with their event (ON DELETE CASCADE).
  return deleteInBatches(db, 'webhook_events', 'received_at < ?', [before]);
}

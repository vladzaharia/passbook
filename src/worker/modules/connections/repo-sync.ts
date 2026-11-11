import { first, run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ConnectionAuthority, connectionAuthPredicate } from './access.ts';
import { type Mode as ConnectionMode, patchConnection } from './repo.ts';
import { commitOrNull, connectionGrant, connectionIs, workflowTracked } from './repo-grants.ts';
import { validCredentialKeysetCommitment } from './repo-passes.ts';

export { recordConnectionAudit } from './repo-connection-audit.ts';
export { commitSyncEnqueue } from './repo-sync-enqueue.ts';
export {
  deleteOldRuns,
  deleteOldWebhookEvents,
  deleteOldWorkflowRuns,
  purgeConnectionWebhooks,
} from './repo-sync-retention.ts';

type RunAuthority = { authority: ConnectionAuthority; now: number };

// Workflow runs
/** A retained tracking row makes this a retry, even if its sibling is missing. */
export async function syncEnqueueExists(db: D1Database, instanceId: string): Promise<boolean> {
  const row = await first<{ present: number }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM workflow_runs WHERE instance_id = ?)
      OR EXISTS (SELECT 1 FROM connection_runs WHERE id = ?) AS present`,
    [instanceId, instanceId],
  );
  return row?.present === 1;
}

export async function setWorkflowStatus(
  db: D1Database,
  instanceId: string,
  status: 'running' | 'complete' | 'errored',
  now: number,
  errorCode: string | null,
  auth: RunAuthority | undefined,
  credentialKeysetCommitment: string,
  scope: {
    orgId: string;
    connectionId: string;
    runnable?: { generation: number; mode: ConnectionMode };
  },
): Promise<boolean> {
  if (
    !validCredentialKeysetCommitment(credentialKeysetCommitment) ||
    !scope?.orgId ||
    !scope.connectionId
  )
    return false;
  const runnable = scope.runnable;
  if (
    runnable !== undefined &&
    (!runnable ||
      !Number.isSafeInteger(runnable.generation) ||
      runnable.generation < 1 ||
      typeof runnable.mode !== 'string' ||
      !runnable.mode)
  )
    return false;
  const predicate = auth ? connectionAuthPredicate(auth.authority, 'c.org_id', auth.now) : null;
  const result = await run(
    db,
    `UPDATE workflow_runs SET status = ?, finished_at = ?, error_code = ?
     WHERE instance_id = ? AND kind = 'connection_sync'
     AND org_id = ? AND target_id = ? AND credential_keyset_commitment = ?
     ${
       runnable
         ? `AND EXISTS (SELECT 1 FROM connections c JOIN orgs o ON o.id = c.org_id
       WHERE c.id = workflow_runs.target_id AND c.org_id = workflow_runs.org_id AND c.enabled = 1
         AND c.generation = ? AND c.mode = ? AND o.status = 'active')`
         : ''
     }
     ${
       predicate
         ? `AND EXISTS (SELECT 1 FROM connections c WHERE c.id = workflow_runs.target_id
       AND c.org_id = workflow_runs.org_id AND ${predicate.sql})`
         : ''
     }`,
    [
      status,
      status === 'running' ? null : now,
      errorCode,
      instanceId,
      scope.orgId,
      scope.connectionId,
      credentialKeysetCommitment,
      ...(runnable ? [runnable.generation, runnable.mode] : []),
      ...(predicate?.params ?? []),
    ],
  );
  return result.changes === 1;
}

/** Read the enqueue proof, not the currently installed keyset, when reconciling a lost run. */
export async function workflowSyncTracking(
  db: D1Database,
  p: { instanceId: string; orgId: string; connectionId: string },
): Promise<{
  startedAt: number;
  status: string;
  credentialKeysetCommitment: string | null;
} | null> {
  const row = await first<{
    started_at: number;
    status: string;
    credential_keyset_commitment: string | null;
  }>(
    db,
    `SELECT started_at, status, credential_keyset_commitment FROM workflow_runs
     WHERE instance_id = ? AND kind = 'connection_sync' AND org_id = ? AND target_id = ?`,
    [p.instanceId, p.orgId, p.connectionId],
  );
  return row
    ? {
        startedAt: row.started_at,
        status: row.status,
        credentialKeysetCommitment: row.credential_keyset_commitment,
      }
    : null;
}

/**
 * Close a tracking row that carries no keyset commitment (a pre-cutover instance). It grants no
 * credential authority; the update is bound to the exact instance, organization and connection.
 */
export async function markLegacyWorkflowLost(
  db: D1Database,
  p: { instanceId: string; orgId: string; connectionId: string; now: number },
): Promise<boolean> {
  const result = await run(
    db,
    `UPDATE workflow_runs SET status = 'errored', finished_at = ?, error_code = 'RUN_LOST'
     WHERE instance_id = ? AND kind = 'connection_sync' AND org_id = ? AND target_id = ?
       AND credential_keyset_commitment IS NULL AND status IN ('queued', 'running')`,
    [p.now, p.instanceId, p.orgId, p.connectionId],
  );
  return result.changes === 1;
}

/** A workflow may only use the keyset bound to its original tracking row. */
export async function syncWorkflowKeysetMatches(
  db: D1Database,
  p: {
    instanceId: string;
    runId: string;
    orgId: string;
    connectionId: string;
    trigger: 'schedule' | 'webhook' | 'admin';
    credentialKeysetCommitment: string;
  },
): Promise<boolean> {
  if (p.instanceId !== p.runId || !validCredentialKeysetCommitment(p.credentialKeysetCommitment))
    return false;
  const row = await first<{ present: number }>(
    db,
    `SELECT 1 AS present FROM workflow_runs w
     JOIN orgs wo ON wo.id = w.org_id
     WHERE w.instance_id = ? AND w.kind = 'connection_sync' AND wo.id = ? AND w.target_id = ?
       AND w.credential_keyset_commitment = ?
       AND EXISTS (SELECT 1 FROM connection_runs r WHERE r.id = w.instance_id
         AND r.connection_id = w.target_id AND r.trigger = ?)`,
    [p.instanceId, p.orgId, p.connectionId, p.credentialKeysetCommitment, p.trigger],
  );
  return row?.present === 1;
}

/** Advance only while the connection keeps the generation, mode and enabled state the sync read. */
export async function advanceConnectionCursor(
  ctx: ServiceContext,
  p: {
    connectionId: string;
    orgId: string;
    generation: number;
    mode: ConnectionMode;
    cursor: string | null;
    credentialKeysetCommitment: string;
  },
): Promise<boolean> {
  if (!validCredentialKeysetCommitment(p.credentialKeysetCommitment)) return false;
  const updated = await patchConnection(
    ctx,
    p.connectionId,
    { cursor: p.cursor },
    {
      actor: { orgId: p.orgId },
      generation: p.generation,
      syncMode: p.mode,
      enabled: true,
    },
  );
  return updated !== 0;
}

/** Only revise the completion written by this invocation, never another retry's result. */
export async function markFinishedRunStale(
  ctx: ServiceContext,
  p: {
    runId: string;
    connectionId: string;
    orgId: string;
    finishedAt: number;
    outcome: 'skipped' | 'error' | 'changed' | 'unchanged';
    errorCode: string | null;
    source: 'workflow' | 'webhook';
    credentialKeysetCommitment: string;
  },
): Promise<void> {
  if (
    (p.source !== 'workflow' && p.source !== 'webhook') ||
    !validCredentialKeysetCommitment(p.credentialKeysetCommitment)
  )
    return;
  const actor = { orgId: p.orgId };
  const g = connectionGrant(
    ctx,
    actor,
    'run.stale',
    [
      connectionIs({ id: p.connectionId }),
      ...(p.source === 'workflow'
        ? [workflowTracked(p.runId, p.connectionId, p.credentialKeysetCommitment)]
        : []),
    ],
    p.runId,
    true,
  );
  g.joined('connection_runs', {
    set: { outcome: 'skipped', error_code: 'STALE_CONTEXT', error_detail: null, http_status: null },
    where: {
      id: p.runId,
      connection_id: p.connectionId,
      finished_at: p.finishedAt,
      outcome: p.outcome,
      error_code: p.errorCode,
    },
    returning: ['id'],
  });
  await commitOrNull(g, actor);
}

/** A later attempt for the same schedule slot (`<slot>-<n>`) that has not finished yet. */
export async function slotAttemptInFlight(
  db: D1Database,
  connectionId: string,
  slot: string,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM workflow_runs WHERE kind = 'connection_sync' AND target_id = ?
         AND substr(instance_id, 1, ?) = ? AND status IN ('queued', 'running') LIMIT 1`,
      [connectionId, slot.length + 1, `${slot}-`],
    )) !== null
  );
}

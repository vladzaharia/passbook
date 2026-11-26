import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { finishRun } from './repo-runs.ts';
import { markLegacyWorkflowLost, setWorkflowStatus, workflowSyncTracking } from './repo-sync.ts';
import { continuationId } from './sync-chain.ts';

/** A scheduled instance still unfinished after this long is checked for being lost. */
export const STUCK_MS = 30 * 60_000;

/**
 * True when the Workflow instance is gone or ended without closing its run. A finished first
 * instance with an open run handed off: its last continuation (`tipSeq`) is the one that counts.
 */
export async function instanceLost(
  sctx: ServiceContext,
  instanceId: string,
  tipSeq: number,
): Promise<boolean> {
  try {
    const statusOf = async (id: string) =>
      (await (await sctx.env.CONNECTION_SYNC.get(id)).status()).status;
    let status = await statusOf(instanceId);
    if (status === 'complete' && tipSeq > 0)
      status = await statusOf(continuationId(instanceId, tipSeq));
    return status === 'errored' || status === 'terminated' || status === 'unknown';
  } catch (error) {
    // A Workflows API failure is treated like a vanished instance; keep the cause visible.
    sctx.log.warn('connection.instance_status_failed', {
      code: error instanceof AppError ? error.code : 'INSTANCE_STATUS_FAILED',
    });
    return true;
  }
}

/**
 * Marks the tracking row lost and closes the run row as RUN_LOST, like any other finished run. A run a newer
 * one replaced (`superseded`) closes as skipped with code SUPERSEDED, and its remaining steps stop.
 */
export async function closeLostRun(
  sctx: ServiceContext,
  p: { orgId: string; connectionId: string; runId: string; superseded?: boolean },
): Promise<void> {
  const code = p.superseded ? 'SUPERSEDED' : 'RUN_LOST';
  const now = sctx.clock.now();
  const db = sctx.env.DB;
  const scope = { orgId: p.orgId, connectionId: p.connectionId };
  const tracking = await workflowSyncTracking(db, { instanceId: p.runId, ...scope });
  const keyset = tracking?.credentialKeysetCommitment ?? null;
  if (keyset === null) await markLegacyWorkflowLost(db, { instanceId: p.runId, ...scope, now });
  else await setWorkflowStatus(db, p.runId, 'errored', now, code, undefined, keyset, scope);
  await finishRun(
    sctx,
    {
      id: p.runId,
      connectionId: p.connectionId,
      finishedAt: now,
      outcome: p.superseded ? 'skipped' : 'error',
      recordsSeen: 0,
      passesChanged: 0,
      errorCode: code,
      errorDetail: null,
      httpStatus: null,
    },
    { orgId: p.orgId },
  );
}

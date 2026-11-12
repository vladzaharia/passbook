import { connectors } from '../../connectors/registry.ts';
import { envString } from '../../platform/env.ts';
import { AppError, ConflictError, ForbiddenError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  ensureCredentialRefKeyset,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { assertConnectionAuthority, type ConnectionAuthority } from './access.ts';
import { schedules } from './health.ts';
import { type ConnectionRow, patchConnection } from './repo.ts';
import { listDueConnections } from './repo-list.ts';
import { validCredentialKeysetCommitment } from './repo-passes.ts';
import {
  commitSyncEnqueue,
  markLegacyWorkflowLost,
  setWorkflowStatus,
  slotAttemptInFlight,
  syncEnqueueExists,
  workflowSyncTracking,
} from './repo-sync.ts';

const DUE_BATCH = 100;
/** A scheduled instance still unfinished after this long is treated as lost. */
const STUCK_MS = 30 * 60_000;
const ADMIN_BUCKET_MS = 30_000;

/** `ADMIN_SYNC_BUCKET_MS` shortens the window for e2e runs; unset or invalid keeps 30 s. */
export function adminBucketMs(env: object): number {
  const n = Number(envString(env, 'ADMIN_SYNC_BUCKET_MS'));
  return Number.isInteger(n) && n >= 100 ? n : ADMIN_BUCKET_MS;
}

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && /already.?exist|instance.*exists/i.test(error.message);
}

export function scheduledInstanceId(conn: Pick<ConnectionRow, 'id' | 'nextRunAt'>): string {
  return `sync-${conn.id}-${conn.nextRunAt}`;
}

/** Same-bucket requests for the same org and generation share an instance. */
export async function adminInstanceId(
  conn: Pick<ConnectionRow, 'id' | 'orgId' | 'generation'>,
  now: number,
  bucketMs: number,
): Promise<string> {
  const scope = await sha256Hex(JSON.stringify([conn.orgId, conn.id, conn.generation]));
  return `sync-${scope.slice(0, 32)}-admin-${Math.floor(now / bucketMs)}`;
}

/** Records the tracking rows, then creates the workflow instance (an existing id counts as started). */
export async function startSync(
  sctx: ServiceContext,
  conn: ConnectionRow,
  trigger: 'schedule' | 'webhook' | 'admin',
  instanceId: string,
  actorId: string | null = null,
  authority?: ConnectionAuthority,
): Promise<{ runId: string; workflowInstanceId: string }> {
  if (authority && authority.orgId !== conn.orgId) throw new ForbiddenError();
  await assertConnectionAuthority(sctx, authority);
  const retry = await syncEnqueueExists(sctx.env.DB, instanceId);
  const credentialKeysetCommitment = retry
    ? await requireCredentialRefKeyset(sctx.env.DB, sctx.env)
    : await ensureCredentialRefKeyset(sctx.env.DB, sctx.env);
  const now = sctx.clock.now();
  const committed = await commitSyncEnqueue(
    sctx,
    {
      instanceId,
      orgId: conn.orgId,
      connectionId: conn.id,
      generation: conn.generation,
      credentialKeysetCommitment,
      trigger,
      actorId,
      startedAt: now,
    },
    { orgId: conn.orgId, authority },
  );
  if (!committed) {
    throw new ConflictError('The connection changed. Reload and retry.', 'CONNECTION_CONFLICT');
  }
  // No user principal enters the workflow; after launch it runs as the connection.
  try {
    await sctx.env.CONNECTION_SYNC.create({
      id: instanceId,
      params: {
        connectionId: conn.id,
        orgId: conn.orgId,
        generation: conn.generation,
        credentialKeysetCommitment,
        trigger,
        runId: instanceId,
      },
    });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
  }
  return { runId: instanceId, workflowInstanceId: instanceId };
}

/** True when the Workflow instance is gone or ended without closing its run. */
async function instanceLost(sctx: ServiceContext, instanceId: string): Promise<boolean> {
  try {
    const { status } = await (await sctx.env.CONNECTION_SYNC.get(instanceId)).status();
    return status === 'errored' || status === 'terminated' || status === 'unknown';
  } catch (error) {
    // A Workflows API failure is treated like a vanished instance; keep the cause visible.
    sctx.log.warn('connection.instance_status_failed', {
      code: error instanceof AppError ? error.code : 'INSTANCE_STATUS_FAILED',
    });
    return true;
  }
}

/** Org- and connection-scoped, with no credential guard: the stuck row never held a keyset. */
async function resumeLegacyRun(
  sctx: ServiceContext,
  conn: ConnectionRow,
  instanceId: string,
  now: number,
): Promise<void> {
  const updated = await patchConnection(
    sctx,
    conn.id,
    { nextRunAt: now, health: 'degraded', lastErrorCode: 'RUN_LOST', lastErrorAt: now },
    {
      actor: { orgId: conn.orgId },
      generation: conn.generation,
      syncMode: conn.mode,
      enabled: true,
    },
  );
  if (!updated) return;
  await markLegacyWorkflowLost(sctx.env.DB, {
    instanceId,
    orgId: conn.orgId,
    connectionId: conn.id,
    now,
  });
  sctx.log.warn('connection.run_lost', { code: 'RUN_LOST', connectionId: conn.id, legacy: true });
}

/** Cron hook: starts a sync for every due connection whose breaker is closed. */
export async function reconcileConnections(sctx: ServiceContext): Promise<void> {
  const now = sctx.clock.now();
  const due = await listDueConnections(sctx.env.DB, now, DUE_BATCH);
  for (const conn of due) {
    if (!schedules(conn)) continue;
    let instanceId = scheduledInstanceId(conn);
    try {
      const tracking = await workflowSyncTracking(sctx.env.DB, {
        instanceId,
        orgId: conn.orgId,
        connectionId: conn.id,
      });
      // The previous instance for this slot finished without moving the schedule (a stale close, for
      // example during a suspension): it cannot run again, so the next attempt gets its own id.
      if (tracking && (tracking.status === 'complete' || tracking.status === 'errored')) {
        if (await slotAttemptInFlight(sctx.env.DB, conn.id, instanceId)) continue;
        instanceId = `${instanceId}-${now}`;
        await startSync(sctx, conn, 'schedule', instanceId);
        continue;
      }
      if (tracking && now - tracking.startedAt > STUCK_MS) {
        const credentialKeysetCommitment = tracking.credentialKeysetCommitment;
        if (credentialKeysetCommitment === null) {
          // In flight at cutover: its instance cannot run under the new authority checks. Once it
          // is dead, the connection is due again at once under a fresh instance.
          if (await instanceLost(sctx, instanceId))
            await resumeLegacyRun(sctx, conn, instanceId, now);
          continue;
        }
        if (
          !validCredentialKeysetCommitment(credentialKeysetCommitment) ||
          (await requireCredentialRefKeyset(sctx.env.DB, sctx.env)) !== credentialKeysetCommitment
        )
          continue;
        // Long runs are legitimate; only a dead instance is replaced.
        if (!(await instanceLost(sctx, instanceId))) continue;
        const seconds =
          conn.intervalSeconds ??
          connectors.get(conn.connectorType)?.defaults.intervalSeconds ??
          900;
        const updated = await patchConnection(
          sctx,
          conn.id,
          {
            nextRunAt: now + seconds * 1000,
            health: 'degraded',
            lastErrorCode: 'RUN_LOST',
            lastErrorAt: now,
          },
          {
            actor: { orgId: conn.orgId },
            generation: conn.generation,
            syncMode: conn.mode,
            enabled: true,
            keyset: { commitment: credentialKeysetCommitment, instanceId },
          },
        );
        if (!updated) continue;
        await setWorkflowStatus(
          sctx.env.DB,
          instanceId,
          'errored',
          now,
          'RUN_LOST',
          undefined,
          credentialKeysetCommitment,
          {
            orgId: conn.orgId,
            connectionId: conn.id,
            runnable: { generation: conn.generation, mode: conn.mode },
          },
        );
        sctx.log.warn('connection.run_lost', { code: 'RUN_LOST', connectionId: conn.id });
        continue;
      }
      await startSync(sctx, conn, 'schedule', instanceId);
    } catch (error) {
      sctx.log.error('connection.schedule_failed', { connectionId: conn.id, error });
    }
  }
}

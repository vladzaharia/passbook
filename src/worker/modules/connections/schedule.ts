import { connectors } from '../../connectors/registry.ts';
import { envString } from '../../platform/env.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
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
  slotAttemptInFlight,
  syncEnqueueExists,
  workflowSyncTracking,
} from './repo-sync.ts';
import { SyncRunOpenError } from './repo-sync-enqueue.ts';
import { openRunOf } from './repo-sync-open.ts';
import { closeLostRun, instanceLost, STUCK_MS } from './run-lost.ts';
import { alreadyExists } from './sync-chain.ts';

const DUE_BATCH = 100;
const ADMIN_BUCKET_MS = 30_000;

/** `ADMIN_SYNC_BUCKET_MS` shortens the window for e2e runs; unset or invalid keeps 30 s. */
export function adminBucketMs(env: object): number {
  const n = Number(envString(env, 'ADMIN_SYNC_BUCKET_MS'));
  return Number.isInteger(n) && n >= 100 ? n : ADMIN_BUCKET_MS;
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

/** A queued run whose launch failed has no instance yet: start it, so adopting it is not a dead end. */
async function ensureInstance(
  sctx: ServiceContext,
  conn: ConnectionRow,
  open: NonNullable<Awaited<ReturnType<typeof openRunOf>>>,
): Promise<void> {
  if (open.status !== 'queued' || !open.keyset) return;
  try {
    await sctx.env.CONNECTION_SYNC.get(open.id);
    return;
  } catch {
    // No such instance: create it below.
  }
  try {
    await sctx.env.CONNECTION_SYNC.create({
      id: open.id,
      params: {
        connectionId: conn.id,
        orgId: conn.orgId,
        // The generation it was enqueued under: a bump since then ends the run as stale.
        generation: open.generation ?? conn.generation,
        credentialKeysetCommitment: open.keyset,
        trigger: open.trigger,
        runId: open.id,
      },
    });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
  }
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
  if (!retry) {
    // Two runs would page the same cursor: adopt the open one while its instance is alive and current.
    const open = await openRunOf(sctx.env.DB, { connectionId: conn.id, instanceId });
    if (open) {
      // A run enqueued under an older generation is fenced out: it cannot do this request's work.
      const current = open.generation === null || open.generation >= conn.generation;
      const alive =
        current &&
        (open.status === 'queued' || open.status === 'running') &&
        (sctx.clock.now() - open.startedAt < STUCK_MS ||
          !(await instanceLost(sctx, open.id, open.tipSeq)));
      if (alive) {
        await ensureInstance(sctx, conn, open);
        return { runId: open.id, workflowInstanceId: open.id };
      }
      await closeLostRun(sctx, { orgId: conn.orgId, connectionId: conn.id, runId: open.id });
    }
  }
  const credentialKeysetCommitment = retry
    ? await requireCredentialRefKeyset(sctx.env.DB, sctx.env)
    : await ensureCredentialRefKeyset(sctx.env.DB, sctx.env);
  const now = sctx.clock.now();
  let committed: boolean;
  try {
    committed = await commitSyncEnqueue(
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
  } catch (error) {
    // A racing request opened the connection's run first.
    if (error instanceof SyncRunOpenError)
      return { runId: error.runId, workflowInstanceId: error.runId };
    throw error;
  }
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
  await closeLostRun(sctx, { orgId: conn.orgId, connectionId: conn.id, runId: instanceId });
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
        const attempt = await slotAttemptInFlight(sctx.env.DB, conn.id, instanceId);
        if (attempt) {
          // A dead retry attempt would otherwise hold the slot forever; the next tick retries.
          if (
            now - attempt.startedAt > STUCK_MS &&
            (await instanceLost(sctx, attempt.id, attempt.tipSeq))
          )
            await closeLostRun(sctx, {
              orgId: conn.orgId,
              connectionId: conn.id,
              runId: attempt.id,
            });
          continue;
        }
        instanceId = `${instanceId}-${now}`;
        await startSync(sctx, conn, 'schedule', instanceId);
        continue;
      }
      if (tracking && now - tracking.startedAt > STUCK_MS) {
        const credentialKeysetCommitment = tracking.credentialKeysetCommitment;
        if (credentialKeysetCommitment === null) {
          // In flight at cutover: its instance cannot run under the new authority checks. Once it
          // is dead, the connection is due again at once under a fresh instance.
          if (await instanceLost(sctx, instanceId, tracking.tipSeq))
            await resumeLegacyRun(sctx, conn, instanceId, now);
          continue;
        }
        if (
          !validCredentialKeysetCommitment(credentialKeysetCommitment) ||
          (await requireCredentialRefKeyset(sctx.env.DB, sctx.env)) !== credentialKeysetCommitment
        )
          continue;
        // Long runs are legitimate; only a dead instance is replaced.
        if (!(await instanceLost(sctx, instanceId, tracking.tipSeq))) continue;
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
        await closeLostRun(sctx, { orgId: conn.orgId, connectionId: conn.id, runId: instanceId });
        sctx.log.warn('connection.run_lost', { code: 'RUN_LOST', connectionId: conn.id });
        continue;
      }
      await startSync(sctx, conn, 'schedule', instanceId);
    } catch (error) {
      sctx.log.error('connection.schedule_failed', { connectionId: conn.id, error });
    }
  }
}

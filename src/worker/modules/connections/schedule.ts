import { connectors } from '../../connectors/registry.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { schedules } from './health.ts';
import { type ConnectionRow, listDueConnections, patchConnection } from './repo.ts';
import { deleteRun, insertRun } from './repo-runs.ts';
import {
  deleteWorkflowRun,
  insertWorkflowRun,
  setWorkflowStatus,
  workflowStartedAt,
} from './repo-sync.ts';

const DUE_BATCH = 100;
/** A scheduled instance still unfinished after this long is treated as lost. */
const STUCK_MS = 30 * 60_000;
const ADMIN_BUCKET_MS = 30_000;

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && /already.?exist|instance.*exists/i.test(error.message);
}

export function scheduledInstanceId(conn: Pick<ConnectionRow, 'id' | 'nextRunAt'>): string {
  return `sync-${conn.id}-${conn.nextRunAt}`;
}

/** Same-bucket requests share an instance, so a double click is one run. */
export function adminInstanceId(connectionId: string, now: number): string {
  return `sync-${connectionId}-admin-${Math.floor(now / ADMIN_BUCKET_MS)}`;
}

/** Records the tracking rows, then creates the workflow instance (an existing id counts as started). */
export async function startSync(
  sctx: ServiceContext,
  conn: ConnectionRow,
  trigger: 'schedule' | 'webhook' | 'admin',
  instanceId: string,
  actorId: string | null = null,
): Promise<{ runId: string; workflowInstanceId: string }> {
  const now = sctx.clock.now();
  const freshWorkflow = await insertWorkflowRun(sctx.env.DB, {
    instanceId,
    orgId: conn.orgId,
    connectionId: conn.id,
    startedAt: now,
  });
  const freshRun = await insertRun(sctx.env.DB, {
    id: instanceId,
    connectionId: conn.id,
    trigger,
    actorId,
    startedAt: now,
  });
  try {
    await sctx.env.CONNECTION_SYNC.create({
      id: instanceId,
      params: { connectionId: conn.id, generation: conn.generation, trigger, runId: instanceId },
    });
  } catch (error) {
    if (!alreadyExists(error)) {
      if (freshWorkflow) await deleteWorkflowRun(sctx.env.DB, instanceId);
      if (freshRun) await deleteRun(sctx.env.DB, instanceId);
      throw error;
    }
  }
  return { runId: instanceId, workflowInstanceId: instanceId };
}

/** True when the Workflow instance is gone or ended without closing its run. */
async function instanceLost(sctx: ServiceContext, instanceId: string): Promise<boolean> {
  try {
    const { status } = await (await sctx.env.CONNECTION_SYNC.get(instanceId)).status();
    return status === 'errored' || status === 'terminated' || status === 'unknown';
  } catch {
    return true;
  }
}

/** Cron hook: starts a sync for every due connection whose breaker is closed. */
export async function reconcileConnections(sctx: ServiceContext): Promise<void> {
  const now = sctx.clock.now();
  const due = await listDueConnections(sctx.env.DB, now, DUE_BATCH);
  for (const conn of due) {
    if (!schedules(conn)) continue;
    const instanceId = scheduledInstanceId(conn);
    try {
      const startedBefore = await workflowStartedAt(sctx.env.DB, instanceId);
      if (startedBefore !== null && now - startedBefore > STUCK_MS) {
        // Long runs are legitimate; only a dead instance is replaced.
        if (!(await instanceLost(sctx, instanceId))) continue;
        const seconds =
          conn.intervalSeconds ??
          connectors.get(conn.connectorType)?.defaults.intervalSeconds ??
          900;
        await patchConnection(
          sctx.env.DB,
          conn.id,
          {
            nextRunAt: now + seconds * 1000,
            health: 'degraded',
            lastErrorCode: 'RUN_LOST',
            lastErrorAt: now,
          },
          conn.generation,
        );
        await setWorkflowStatus(sctx.env.DB, instanceId, 'errored', now, 'RUN_LOST');
        sctx.log.warn('connection.run_lost', { connectionId: conn.id });
        continue;
      }
      await startSync(sctx, conn, 'schedule', instanceId);
    } catch (error) {
      sctx.log.error('connection.schedule_failed', { connectionId: conn.id, error });
    }
  }
}

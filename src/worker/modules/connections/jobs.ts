import type { JobOf } from '../../jobs/types.ts';
import { claim } from '../../platform/counters.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getDeps } from './deps.ts';
import { type ConnectionRefresh, refreshFromConnection } from './job-refresh-connection.ts';
import { syncKeysetCurrent } from './keyset-current.ts';
import { quarantineLegacyWebhookEvents } from './legacy-quarantine.ts';
import { getConnection } from './repo.ts';
import { type RefreshSnapshot, refreshSnapshotCurrent } from './repo-pass-refresh.ts';
import { getPassById } from './repo-passes.ts';
import { deleteOldRuns, deleteOldWebhookEvents, deleteOldWorkflowRuns } from './repo-sync.ts';
import { reconcileConnections as schedule } from './schedule.ts';
import { processWebhook } from './webhook-process.ts';
import { sweepStalledReplays, sweepUndispatchedWebhooks } from './webhook-redispatch.ts';

const DAY_MS = 86_400_000;
export const RUN_RETENTION_MS = 30 * DAY_MS;
export const RUNS_KEPT_PER_CONNECTION = 1000;
export const WEBHOOK_RETENTION_MS = 7 * DAY_MS;
/** Failed, blocked and ignored retained payloads expire after this, unless an item is unresolved. */
export const FAILED_WEBHOOK_TTL_MS = 30 * DAY_MS;

/** A durable snapshot fences fetch, publication and the catch-up push. */
export async function handlePassRefresh(
  job: JobOf<'pass.refresh'>,
  ctx: ServiceContext,
): Promise<void> {
  const db = ctx.env.DB;
  if (!(await refreshSnapshotCurrent(db, job))) {
    ctx.log.info('pass.refresh_stale', { passId: job.passId });
    return;
  }
  if (!(await syncKeysetCurrent(ctx, job.credentialKeysetCommitment))) {
    ctx.log.info('pass.refresh_stale', { passId: job.passId });
    return;
  }
  const pass = await getPassById(db, job.passId);
  if (
    !pass ||
    pass.orgId !== job.orgId ||
    pass.mode !== job.mode ||
    pass.status !== job.status ||
    pass.version !== job.passVersion ||
    pass.identityId !== job.identityId ||
    pass.credentialGeneration !== job.credentialGeneration ||
    pass.lifecycleGeneration !== job.lifecycleGeneration ||
    pass.credentialKeysetCommitment !== job.credentialKeysetCommitment ||
    pass.transferPending !== false ||
    pass.ownerUserId !== job.ownerUserId ||
    pass.linkGeneration !== job.linkGeneration ||
    pass.connectionId !== job.connectionId ||
    pass.externalRef !== job.externalRef ||
    pass.templateId !== job.templateId ||
    pass.templateVersion !== job.templateVersion ||
    pass.releaseId !== job.releaseId ||
    pass.deletedAt !== null ||
    pass.removedAt !== null
  ) {
    ctx.log.info('pass.refresh_stale', { passId: job.passId });
    return;
  }
  let snapshot: RefreshSnapshot | null = job;
  let finish: ConnectionRefresh['finish'] | undefined;
  let stale = false;
  if (job.connectionId) {
    const conn = await getConnection(db, job.connectionId);
    if (
      !conn?.enabled ||
      conn.orgId !== job.orgId ||
      conn.generation !== job.generation ||
      conn.mode !== job.connectionMode
    ) {
      ctx.log.info('pass.refresh_stale', { passId: job.passId });
      return;
    }
    const result = await refreshFromConnection(ctx, job, pass, conn);
    if (!result) {
      ctx.log.info('pass.refresh_stale', { passId: job.passId });
      return;
    }
    snapshot = result.snapshot;
    finish = result.finish;
    stale = result.stale;
  }
  if (!snapshot) {
    if (finish) await finish(stale);
    return;
  }
  try {
    if ((await requireCredentialRefKeyset(db, ctx.env)) !== snapshot.credentialKeysetCommitment) {
      if (finish) await finish(true);
      ctx.log.info('pass.refresh_stale', { passId: job.passId });
      return;
    }
    const queued = await getDeps().enqueueRefreshPush(ctx, snapshot);
    if (finish) await finish(!queued);
    if (!queued) ctx.log.info('pass.refresh_stale', { passId: job.passId });
  } catch (error) {
    if (finish) await finish(false);
    throw error;
  }
}

export async function handleConnectionWebhook(
  job: JobOf<'connection.webhook'>,
  ctx: ServiceContext,
): Promise<void> {
  await processWebhook(ctx, job);
}

/** Each retention step runs on its own: one failing step is logged and cannot cancel the others. */
async function step<T>(ctx: ServiceContext, name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    ctx.log.error('connections.retention_step_failed', {
      step: name,
      code: error instanceof AppError ? error.code : 'RETENTION_STEP_FAILED',
    });
    return null;
  }
}

export async function dailyConnections(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const runs = await step(ctx, 'runs', () =>
    deleteOldRuns(ctx, now - RUN_RETENTION_MS, RUNS_KEPT_PER_CONNECTION),
  );
  await step(ctx, 'quarantine', () =>
    quarantineLegacyWebhookEvents(ctx, now - WEBHOOK_RETENTION_MS),
  );
  const events = await step(ctx, 'events', () =>
    deleteOldWebhookEvents(ctx, now - WEBHOOK_RETENTION_MS, now - FAILED_WEBHOOK_TTL_MS),
  );
  const workflows = await step(ctx, 'workflows', () =>
    deleteOldWorkflowRuns(ctx.env.DB, now - RUN_RETENTION_MS),
  );
  ctx.log.info('connections.retention', { runs, events, workflows });
}

/**
 * Minute cron hook. The daily cron has no connections entry, so retention piggybacks here, claimed
 * once per UTC day through the counters table.
 */
export async function reconcileConnections(ctx: ServiceContext): Promise<void> {
  await step(ctx, 'schedule', () => schedule(ctx));
  await step(ctx, 'dispatch_sweep', () => sweepUndispatchedWebhooks(ctx));
  await step(ctx, 'replay_sweep', () => sweepStalledReplays(ctx));
  try {
    await quarantineLegacyWebhookEvents(ctx, ctx.clock.now() - WEBHOOK_RETENTION_MS);
  } catch {
    ctx.log.error('connection.legacy_quarantine_failed', { code: 'LEGACY_QUARANTINE_FAILED' });
  }
  const day = Math.floor(ctx.clock.now() / DAY_MS) * DAY_MS;
  if (await claim(ctx.env.DB, 'retention:connections', day)) await dailyConnections(ctx);
}

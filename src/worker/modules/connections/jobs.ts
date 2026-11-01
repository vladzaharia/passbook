import type { JobOf } from '../../jobs/types.ts';
import { run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import { getDeps } from './deps.ts';
import { applyIncoming, fromResult } from './records.ts';
import { getConnection } from './repo.ts';
import { getPassById, setLastRefreshed } from './repo-passes.ts';
import { finishRun, insertRun } from './repo-runs.ts';
import { deleteOldRuns, deleteOldWebhookEvents, deleteOldWorkflowRuns } from './repo-sync.ts';
import { classify, prepare } from './runtime.ts';
import { reconcileConnections as schedule } from './schedule.ts';
import { processWebhook } from './webhooks.ts';

const DAY_MS = 86_400_000;
export const RUN_RETENTION_MS = 30 * DAY_MS;
export const RUNS_KEPT_PER_CONNECTION = 1000;
export const WEBHOOK_RETENTION_MS = 7 * DAY_MS;

async function refreshFromConnection(
  sctx: ServiceContext,
  job: JobOf<'pass.refresh'>,
  pass: NonNullable<Awaited<ReturnType<typeof getPassById>>>,
): Promise<void> {
  const db = sctx.env.DB;
  const conn = pass.connectionId ? await getConnection(db, pass.connectionId) : null;
  // A pass can only be refreshed through a connection of its own org.
  if (!conn || conn.orgId !== pass.orgId || !pass.externalRef) return;
  if (!(await isOrgActive(sctx, conn.orgId))) return;
  const runId = sctx.ids.id();
  const startedAt = sctx.clock.now();
  await insertRun(db, {
    id: runId,
    connectionId: conn.id,
    trigger: job.trigger,
    actorId: job.actorId,
    passId: pass.id,
    startedAt,
  });
  const done = (
    outcome: 'unchanged' | 'changed' | 'error' | 'skipped',
    errorCode: string | null,
    httpStatus: number | null,
  ) =>
    finishRun(db, {
      id: runId,
      finishedAt: sctx.clock.now(),
      outcome,
      recordsSeen: outcome === 'skipped' ? 0 : 1,
      passesChanged: outcome === 'changed' ? 1 : 0,
      errorCode,
      errorDetail: null,
      httpStatus,
    });

  if (!conn.enabled || (conn.breakerOpenUntil ?? 0) > startedAt) {
    await done('skipped', conn.enabled ? 'BREAKER_OPEN' : 'DISABLED', null);
    return;
  }
  try {
    const prep = await prepare(sctx, conn);
    const result = await prep.def.fetchRecord(prep.cc, pass.externalRef);
    const outcome = await applyIncoming(sctx, conn, pass.externalRef, fromResult(result), {
      generation: conn.generation,
      cause: job.trigger === 'user' ? 'user_refresh' : 'connection',
      intervalMs: prep.intervalMs,
    });
    if (outcome === 'invalid') await done('error', 'RECORD_INVALID', null);
    else
      await done(
        outcome === 'changed' || outcome === 'missing' ? 'changed' : 'unchanged',
        null,
        null,
      );
  } catch (error) {
    // Upstream trouble never alters the pass; the re-push below still happens.
    const failure = classify(error);
    if (failure.code === 'INTERNAL')
      sctx.log.error('connection.refresh_failed', { passId: pass.id, error });
    await done('error', failure.code, failure.httpStatus);
  }
}

/** Fetches the connected record (if any), then always re-pushes so devices that missed a push catch up. */
export async function handlePassRefresh(
  job: JobOf<'pass.refresh'>,
  ctx: ServiceContext,
): Promise<void> {
  const pass = await getPassById(ctx.env.DB, job.passId);
  if (!pass) {
    ctx.log.warn('pass.refresh_missing', { code: 'PASS_MISSING', passId: job.passId });
    return;
  }
  try {
    if (pass.connectionId) await refreshFromConnection(ctx, job, pass);
  } finally {
    await getDeps().enqueuePush(ctx, pass.id, 'refresh');
    await setLastRefreshed(ctx.env.DB, pass.id, ctx.clock.now());
  }
}

export async function handleConnectionWebhook(
  job: JobOf<'connection.webhook'>,
  ctx: ServiceContext,
): Promise<void> {
  await processWebhook(ctx, job);
}

export async function dailyConnections(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const runs = await deleteOldRuns(ctx.env.DB, now - RUN_RETENTION_MS, RUNS_KEPT_PER_CONNECTION);
  const events = await deleteOldWebhookEvents(ctx.env.DB, now - WEBHOOK_RETENTION_MS);
  const workflows = await deleteOldWorkflowRuns(ctx.env.DB, now - RUN_RETENTION_MS);
  ctx.log.info('connections.retention', { runs, events, workflows });
}

/**
 * Minute cron hook. The daily cron has no connections entry, so retention piggybacks here, claimed
 * once per UTC day through the counters table.
 */
export async function reconcileConnections(ctx: ServiceContext): Promise<void> {
  await schedule(ctx);
  const day = Math.floor(ctx.clock.now() / DAY_MS) * DAY_MS;
  const claimed = await run(
    ctx.env.DB,
    "INSERT OR IGNORE INTO counters (key, window_start, count) VALUES ('retention:connections', ?, 1)",
    [day],
  );
  if (claimed.changes === 1) await dailyConnections(ctx);
}

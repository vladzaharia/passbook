import type { JobOf } from '../../jobs/types.ts';
import { claim } from '../../platform/counters.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getDeps } from './deps.ts';
import { applyIncoming, fromResult } from './records.ts';
import { type ConnectionRow, getConnection } from './repo.ts';
import {
  getPassById,
  type RefreshSnapshot,
  refreshSnapshotCurrent,
  type SyncPass,
} from './repo-passes.ts';
import { finishRun, insertRun } from './repo-runs.ts';
import { deleteOldRuns, deleteOldWebhookEvents, deleteOldWorkflowRuns } from './repo-sync.ts';
import { classify, prepare } from './runtime.ts';
import { reconcileConnections as schedule } from './schedule.ts';
import { processWebhook } from './webhooks.ts';

const DAY_MS = 86_400_000;
export const RUN_RETENTION_MS = 30 * DAY_MS;
export const RUNS_KEPT_PER_CONNECTION = 1000;
export const WEBHOOK_RETENTION_MS = 7 * DAY_MS;

interface ConnectionRefresh {
  snapshot: RefreshSnapshot | null;
  stale: boolean;
  finish(stale: boolean): Promise<void>;
}

async function refreshFromConnection(
  sctx: ServiceContext,
  job: JobOf<'pass.refresh'>,
  pass: SyncPass,
  conn: ConnectionRow,
): Promise<ConnectionRefresh | null> {
  const db = sctx.env.DB;
  const generation = job.generation;
  const ref = job.externalRef;
  if (generation === null || ref === null) return null;
  const runId = sctx.ids.id();
  const startedAt = sctx.clock.now();
  const inserted = await insertRun(db, {
    id: runId,
    connectionId: conn.id,
    trigger: job.trigger,
    actorId: job.actorId,
    passId: pass.id,
    startedAt,
    expected: {
      orgId: job.orgId,
      generation,
      pass: {
        id: job.passId, mode: 'live', status: 'active', version: job.passVersion,
        ownerUserId: job.ownerUserId, linkGeneration: job.linkGeneration, externalRef: ref,
      },
    },
  });
  if (!inserted) return null;
  let outcome: 'unchanged' | 'changed' | 'error' | 'skipped' = 'skipped';
  let errorCode: string | null = null;
  let httpStatus: number | null = null;
  let recordsSeen = 0;
  let snapshot: RefreshSnapshot | null = job;
  const finish = (stale: boolean) =>
    finishRun(db, {
      id: runId,
      finishedAt: sctx.clock.now(),
      outcome: stale ? 'skipped' : outcome,
      recordsSeen,
      passesChanged: outcome === 'changed' ? 1 : 0,
      errorCode: stale ? 'STALE_CONTEXT' : errorCode,
      errorDetail: null,
      httpStatus,
    });

  if ((conn.breakerOpenUntil ?? 0) > startedAt) {
    errorCode = 'BREAKER_OPEN';
    return { snapshot, finish, stale: false };
  }
  try {
    const prep = await prepare(sctx, conn);
    // Preparation may decrypt credentials or resolve DNS; the queued snapshot must still match
    // immediately before the connector request and again in the eventual commit predicate.
    if (!(await refreshSnapshotCurrent(db, job))) return { snapshot: null, finish, stale: true };
    if (!ref) return { snapshot: null, finish, stale: true };
    const result = await prep.def.fetchRecord(prep.cc, ref);
    recordsSeen = 1;
    const applied = await applyIncoming(sctx, conn, ref, fromResult(result), {
      generation,
      cause: job.trigger === 'user' ? 'user_refresh' : 'connection',
      intervalMs: prep.intervalMs,
      passes: new Map([[ref, pass]]),
    });
    if (applied.outcome === 'fenced' || applied.outcome === 'deferred' || applied.outcome === 'unlinked') {
      snapshot = null;
    } else {
      outcome = applied.outcome === 'invalid' ? 'error'
        : applied.outcome === 'changed' || applied.outcome === 'missing' ? 'changed' : 'unchanged';
      if (applied.outcome === 'invalid') errorCode = 'RECORD_INVALID';
      if (applied.version !== undefined && applied.status !== undefined &&
          applied.ownerUserId !== undefined && applied.linkGeneration !== undefined) {
        snapshot = {
          ...job,
          passVersion: applied.version,
          status: applied.status,
          ownerUserId: applied.ownerUserId,
          linkGeneration: applied.linkGeneration,
        };
      }
      // Voiding already publishes its own push; a removed binding must not get a catch-up write.
      if (applied.status === 'voided') return { snapshot: null, finish, stale: false };
    }
  } catch (error) {
    if (error instanceof ConflictError) {
      sctx.log.info('connection.refresh_stale', { passId: pass.id, code: error.code });
      snapshot = null;
    } else {
      const failure = classify(error);
      if (failure.code === 'INTERNAL')
        sctx.log.error('connection.refresh_failed', { passId: pass.id, error });
      outcome = 'error';
      errorCode = failure.code;
      httpStatus = failure.httpStatus;
    }
  }
  return { snapshot, finish, stale: snapshot === null };
}

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
  const pass = await getPassById(db, job.passId);
  if (!pass || pass.orgId !== job.orgId || pass.mode !== job.mode ||
      pass.status !== job.status || pass.version !== job.passVersion || pass.ownerUserId !== job.ownerUserId ||
      pass.linkGeneration !== job.linkGeneration ||
      pass.connectionId !== job.connectionId || pass.externalRef !== job.externalRef ||
      pass.deletedAt !== null || pass.removedAt !== null) {
    ctx.log.info('pass.refresh_stale', { passId: job.passId });
    return;
  }
  let snapshot: RefreshSnapshot | null = job;
  let finish: ConnectionRefresh['finish'] | undefined;
  let stale = false;
  if (job.connectionId) {
    const conn = await getConnection(db, job.connectionId);
    if (!conn?.enabled || conn.orgId !== job.orgId || conn.generation !== job.generation) {
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
  if (await claim(ctx.env.DB, 'retention:connections', day)) await dailyConnections(ctx);
}

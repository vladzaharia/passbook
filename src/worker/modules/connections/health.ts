import { connectors } from '../../connectors/registry.ts';
import { writeEvent } from '../../platform/analytics.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { Totals } from './records.ts';
import { type ConnectionRow, getConnection, patchConnection } from './repo.ts';
import { finishRun } from './repo-runs.ts';
import { setWorkflowStatus } from './repo-sync.ts';
import type { Failure } from './runtime.ts';

export const BREAKER_THRESHOLD = 5;
const BREAKER_BASE_MS = 5 * 60_000;
const BREAKER_MAX_MS = 60 * 60_000;

/** 5 min after the 5th consecutive failure, doubling each further failure, capped at 1 h. */
export function breakerDelayMs(failures: number): number {
  return Math.min(BREAKER_MAX_MS, BREAKER_BASE_MS * 2 ** Math.max(0, failures - BREAKER_THRESHOLD));
}

export function schedules(conn: Pick<ConnectionRow, 'mode'>): boolean {
  return conn.mode === 'poll' || conn.mode === 'hybrid';
}

export interface RunOutcome {
  runId: string;
  instanceId: string | null;
  generation: number;
  totals: Totals;
  failure: Failure | null;
  stale: boolean;
  startedAt: number;
  /** First failing records, one per line. */
  errorDetail?: string | null;
}

/**
 * Closes a run: writes connection_runs, health, breaker and the next schedule. Every write is
 * fenced on `generation`, so a run that started before a config change cannot overwrite it.
 */
export async function closeRun(
  sctx: ServiceContext,
  connectionId: string,
  outcome: RunOutcome,
  options: { countsForBreaker: boolean; reschedule?: boolean },
): Promise<void> {
  const db = sctx.env.DB;
  const now = sctx.clock.now();
  const { totals, failure } = outcome;
  const conn = await getConnection(db, connectionId);
  const changedAny = totals.changed + totals.created + totals.missing > 0;

  await finishRun(db, {
    id: outcome.runId,
    finishedAt: now,
    outcome: outcome.stale ? 'skipped' : failure ? 'error' : changedAny ? 'changed' : 'unchanged',
    recordsSeen: totals.seen,
    passesChanged: totals.changed + totals.created + totals.missing,
    errorCode: outcome.stale
      ? 'STALE_GENERATION'
      : (failure?.code ?? (totals.errors > 0 ? 'RECORD_ERRORS' : null)),
    errorDetail: outcome.errorDetail ?? null,
    httpStatus: failure?.httpStatus ?? null,
  });
  if (outcome.instanceId) await setWorkflowStatus(db, outcome.instanceId, 'complete', now);
  writeEvent(sctx.env, {
    event: 'sync.run',
    orgId: conn?.orgId ?? null,
    outcome: outcome.stale ? 'stale' : (failure?.code ?? 'ok'),
    value: now - outcome.startedAt,
  });

  const reschedule = options.reschedule ?? true;
  const intervalMs = conn
    ? (conn.intervalSeconds ??
        connectors.get(conn.connectorType)?.defaults.intervalSeconds ??
        900) * 1000
    : 0;
  if (!conn?.enabled || outcome.stale || !options.countsForBreaker) return;
  if (conn.generation !== outcome.generation) return;

  if (failure) {
    const failures = conn.consecutiveFailures + 1;
    const open = failures >= BREAKER_THRESHOLD;
    const breakerOpenUntil = open ? now + breakerDelayMs(failures) : null;
    const retryAt = now + Math.max(intervalMs, failure.retryAfterMs ?? 0);
    await patchConnection(
      db,
      connectionId,
      {
        consecutiveFailures: failures,
        health: open ? 'failing' : 'degraded',
        breakerOpenUntil,
        lastRunAt: now,
        lastErrorCode: failure.code,
        lastErrorAt: now,
        ...(reschedule
          ? { nextRunAt: schedules(conn) ? Math.max(retryAt, breakerOpenUntil ?? 0) : null }
          : {}),
        updatedAt: now,
      },
      outcome.generation,
    );
    if (open && conn.consecutiveFailures < BREAKER_THRESHOLD) {
      await recordAudit(sctx, {
        orgId: conn.orgId,
        actorType: 'connection',
        actorId: conn.id,
        action: 'connection.breaker_open',
        targetType: 'connection',
        targetId: conn.id,
        detail: { code: failure.code, failures },
      });
    }
    return;
  }

  const partial = totals.errors > 0;
  await patchConnection(
    db,
    connectionId,
    {
      consecutiveFailures: 0,
      breakerOpenUntil: null,
      health: partial ? 'degraded' : 'healthy',
      lastRunAt: now,
      lastSuccessAt: now,
      ...(partial ? { lastErrorCode: 'RECORD_ERRORS', lastErrorAt: now } : { lastErrorCode: null }),
      ...(reschedule ? { nextRunAt: schedules(conn) ? now + intervalMs : null } : {}),
      updatedAt: now,
    },
    outcome.generation,
  );
}

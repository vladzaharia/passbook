import { connectors } from '../../connectors/registry.ts';
import { writeEvent } from '../../platform/analytics.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { isOrgActive } from '../orgs/active.ts';
import { syncKeysetCurrent } from './keyset-current.ts';
import type { ReleaseBlockCode, Totals } from './records.ts';
import { type ConnectionRow, getConnection, type PatchGuard, patchConnection } from './repo.ts';
import { validCredentialKeysetCommitment } from './repo-passes.ts';
import { finishRun } from './repo-runs.ts';
import { markFinishedRunStale, setWorkflowStatus } from './repo-sync.ts';
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

export type RunOutcome = {
  runId: string;
  orgId: string;
  generation: number;
  /** Captured mode for work whose enqueue or start provided one. */
  connectionMode?: ConnectionRow['mode'];
  totals: Totals;
  failure: Failure | null;
  stale: boolean;
  staleCode?: 'STALE_CONTEXT' | 'STALE_GENERATION';
  releaseBlocked?: ReleaseBlockCode;
  startedAt: number;
  /** First failing records, one per line. */
  errorDetail?: string | null;
} & (
  | { source: 'workflow'; instanceId: string; credentialKeysetCommitment: string }
  | { source: 'webhook'; instanceId: null; credentialKeysetCommitment: string }
);

/** Health, schedule and breaker writes need the config the run read, never anything volatile. */
const guardOf = (o: RunOutcome, keyset: PatchGuard['keyset']): PatchGuard => ({
  actor: { orgId: o.orgId },
  generation: o.generation,
  enabled: true,
  ...(o.connectionMode === undefined ? {} : { syncMode: o.connectionMode }),
  ...(keyset === undefined ? {} : { keyset }),
});

/**
 * Closes a run, fencing completion, health, breaker and schedule writes on the original
 * keyset, connection generation and active organization.
 * Returns whether the run was stale, including races during a health update.
 */
export async function closeRun(
  sctx: ServiceContext,
  connectionId: string,
  outcome: RunOutcome,
  options: { countsForBreaker: boolean; reschedule?: boolean },
): Promise<boolean> {
  if (outcome.source !== 'workflow' && outcome.source !== 'webhook') return true;
  if (!validCredentialKeysetCommitment(outcome.credentialKeysetCommitment)) return true;
  if (outcome.source === 'webhook' && outcome.instanceId !== null) return true;
  if (
    outcome.source === 'workflow' &&
    (typeof outcome.instanceId !== 'string' ||
      !outcome.instanceId ||
      outcome.runId !== outcome.instanceId)
  ) {
    return true;
  }
  // The keyset is an immutable singleton: it is pinned once here instead of in every statement.
  if (!(await syncKeysetCurrent(sctx, outcome.credentialKeysetCommitment))) return true;
  const keysetGuard =
    outcome.source === 'workflow'
      ? { commitment: outcome.credentialKeysetCommitment, instanceId: outcome.instanceId }
      : { commitment: outcome.credentialKeysetCommitment, source: 'webhook' as const };
  const db = sctx.env.DB;
  const now = sctx.clock.now();
  const { totals, failure, releaseBlocked } = outcome;
  const conn = await getConnection(db, connectionId);
  // A pass race must not discard another record blocked on approval; stale connection context wins.
  const contextLost =
    !outcome.orgId ||
    !conn?.enabled ||
    conn.orgId !== outcome.orgId ||
    (outcome.connectionMode !== undefined && conn.mode !== outcome.connectionMode) ||
    !Number.isSafeInteger(outcome.generation) ||
    outcome.generation < 1 ||
    !Number.isSafeInteger(conn.generation) ||
    conn.generation < 1 ||
    !(await isOrgActive(sctx, outcome.orgId));
  const generationChanged = !contextLost && conn !== null && conn.generation !== outcome.generation;
  const passStale = !releaseBlocked && outcome.stale;
  const stale = passStale || contextLost || generationChanged;
  const changedAny = totals.changed + totals.created + totals.missing > 0;

  const runOutcome = stale
    ? 'skipped'
    : failure || releaseBlocked
      ? 'error'
      : changedAny
        ? 'changed'
        : 'unchanged';
  // Counter drift reported by the pass layer is generation drift even when the connection's
  // own generation is unchanged.
  const runErrorCode = stale
    ? contextLost || (passStale && outcome.staleCode === 'STALE_CONTEXT')
      ? 'STALE_CONTEXT'
      : generationChanged || (passStale && outcome.staleCode === 'STALE_GENERATION')
        ? 'STALE_GENERATION'
        : 'STALE_CONTEXT'
    : (releaseBlocked ?? failure?.code ?? (totals.errors > 0 ? 'RECORD_ERRORS' : null));
  const finished = await finishRun(
    sctx,
    {
      id: outcome.runId,
      connectionId,
      finishedAt: now,
      outcome: runOutcome,
      recordsSeen: totals.seen,
      passesChanged: totals.changed + totals.created + totals.missing,
      errorCode: runErrorCode,
      errorDetail: outcome.errorDetail ?? null,
      httpStatus: releaseBlocked ? null : (failure?.httpStatus ?? null),
      credentialKeysetCommitment: outcome.credentialKeysetCommitment,
      ...(outcome.source === 'workflow' ? { workflowInstanceId: outcome.instanceId } : {}),
      ...(outcome.source === 'workflow' && stale
        ? { staleWorkflowScope: { orgId: outcome.orgId, connectionId } }
        : {}),
      ...(!stale
        ? {
            expected: {
              connectionId,
              orgId: outcome.orgId,
              generation: outcome.generation,
              requireEnabled: true,
              ...(outcome.connectionMode !== undefined ? { mode: outcome.connectionMode } : {}),
            },
          }
        : {}),
    },
    { orgId: outcome.orgId },
  );
  if (outcome.source === 'workflow') {
    await setWorkflowStatus(
      db,
      outcome.instanceId,
      'complete',
      now,
      null,
      undefined,
      outcome.credentialKeysetCommitment,
      { orgId: outcome.orgId, connectionId },
    );
  }
  writeEvent(sctx.env, {
    event: 'sync.run',
    orgId: conn?.orgId ?? null,
    outcome: stale ? 'stale' : (releaseBlocked ?? failure?.code ?? 'ok'),
    value: now - outcome.startedAt,
  });

  const markStaleRace = async (): Promise<boolean> => {
    if (finished) {
      await markFinishedRunStale(sctx, {
        runId: outcome.runId,
        connectionId,
        orgId: outcome.orgId,
        finishedAt: now,
        outcome: runOutcome,
        errorCode: runErrorCode,
        credentialKeysetCommitment: outcome.credentialKeysetCommitment,
        source: outcome.source,
      });
    }
    return true;
  };

  const reschedule = options.reschedule ?? true;
  const intervalMs = conn
    ? (conn.intervalSeconds ??
        connectors.get(conn.connectorType)?.defaults.intervalSeconds ??
        900) * 1000
    : 0;
  // Without a health CAS, a rejected finish is the only signal that the proof went stale.
  if (!conn?.enabled || stale || !options.countsForBreaker) return stale || !finished;

  if (releaseBlocked) {
    // Approval is not an upstream failure and must not trip its circuit breaker.
    const updated = await patchConnection(
      sctx,
      connectionId,
      {
        health: conn.health === 'failing' ? 'failing' : 'degraded',
        lastRunAt: now,
        lastErrorCode: releaseBlocked,
        lastErrorAt: now,
        ...(reschedule && schedules(conn) ? { nextRunAt: now + intervalMs } : {}),
        updatedAt: now,
      },
      guardOf(outcome, keysetGuard),
    );
    return updated === 0 ? markStaleRace() : false;
  }

  if (failure) {
    const failures = conn.consecutiveFailures + 1;
    const open = failures >= BREAKER_THRESHOLD;
    const breakerOpenUntil = open ? now + breakerDelayMs(failures) : null;
    const retryAt = now + Math.max(intervalMs, failure.retryAfterMs ?? 0);
    const updated = await patchConnection(
      sctx,
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
      guardOf(outcome, keysetGuard),
    );
    if (updated === 1 && open && conn.consecutiveFailures < BREAKER_THRESHOLD) {
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
    return updated === 0 ? markStaleRace() : false;
  }

  const partial = totals.errors > 0;
  const updated = await patchConnection(
    sctx,
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
    guardOf(outcome, keysetGuard),
  );
  return updated === 0 ? markStaleRace() : false;
}

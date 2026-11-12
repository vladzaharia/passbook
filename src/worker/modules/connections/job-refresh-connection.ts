import type { JobOf } from '../../jobs/types.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { markRefreshCompleted } from '../delivery/repo-outbox-refresh.ts';
import { syncKeysetCurrent } from './keyset-current.ts';
import { fromResult } from './record-helpers.ts';
import { applyIncoming } from './records.ts';
import type { ConnectionRow } from './repo.ts';
import {
  passVersionRowVersion,
  type RefreshSnapshot,
  refreshSnapshotCurrent,
} from './repo-pass-refresh.ts';
import type { SyncPass } from './repo-passes.ts';
import { finishRun, insertRun } from './repo-runs.ts';
import { classify, prepare } from './runtime.ts';

export interface ConnectionRefresh {
  snapshot: RefreshSnapshot | null;
  stale: boolean;
  finish(stale: boolean): Promise<void>;
}

export async function refreshFromConnection(
  sctx: ServiceContext,
  job: JobOf<'pass.refresh'>,
  pass: SyncPass,
  conn: ConnectionRow,
): Promise<ConnectionRefresh | null> {
  const db = sctx.env.DB;
  const generation = job.generation;
  const ref = job.externalRef;
  const connectionMode = job.connectionMode;
  if (
    generation === null ||
    ref === null ||
    connectionMode === null ||
    conn.mode !== connectionMode
  )
    return null;
  const runId = sctx.ids.id();
  const startedAt = sctx.clock.now();
  const inserted = await insertRun(
    sctx,
    {
      id: runId,
      connectionId: conn.id,
      trigger: job.trigger,
      actorId: job.actorId,
      passId: pass.id,
      startedAt,
      expected: {
        orgId: job.orgId,
        generation,
        mode: connectionMode,
        credentialKeysetCommitment: job.credentialKeysetCommitment,
        pass: {
          id: job.passId,
          mode: 'live',
          status: 'active',
          version: job.passVersion,
          identityId: job.identityId,
          credentialGeneration: job.credentialGeneration,
          lifecycleGeneration: job.lifecycleGeneration,
          transferPending: pass.transferPending,
          ownerUserId: job.ownerUserId,
          linkGeneration: job.linkGeneration,
          externalRef: ref,
          templateId: job.templateId,
          templateVersion: job.templateVersion,
          releaseId: job.releaseId,
          credentialKeysetCommitment: job.credentialKeysetCommitment,
        },
      },
    },
    { orgId: job.orgId },
  );
  if (!inserted) return null;
  let outcome: 'unchanged' | 'changed' | 'error' | 'skipped' = 'skipped';
  let errorCode: string | null = null;
  let httpStatus: number | null = null;
  let staleCode: 'STALE_CONTEXT' | 'STALE_GENERATION' = 'STALE_CONTEXT';
  let recordsSeen = 0;
  let snapshot: RefreshSnapshot | null = job;
  const finish = async (stale: boolean): Promise<void> => {
    await finishRun(
      sctx,
      {
        id: runId,
        connectionId: conn.id,
        credentialKeysetCommitment: job.credentialKeysetCommitment,
        finishedAt: sctx.clock.now(),
        // A failed fetch or apply keeps its real code even when the snapshot is then dropped.
        outcome: outcome === 'error' ? 'error' : stale ? 'skipped' : outcome,
        recordsSeen,
        passesChanged: outcome === 'changed' ? 1 : 0,
        errorCode: outcome === 'error' ? errorCode : stale ? staleCode : errorCode,
        errorDetail: null,
        httpStatus,
      },
      { orgId: job.orgId },
    );
  };

  if ((conn.breakerOpenUntil ?? 0) > startedAt) {
    errorCode = 'BREAKER_OPEN';
    return { snapshot, finish, stale: false };
  }
  if (!(await refreshSnapshotCurrent(db, job))) return { snapshot: null, finish, stale: true };
  if (!(await syncKeysetCurrent(sctx, job.credentialKeysetCommitment)))
    return { snapshot: null, finish, stale: true };
  let applying = false;
  try {
    const prep = await prepare(sctx, conn);
    // Preparation may decrypt credentials or resolve DNS; the queued snapshot must still match
    // immediately before the connector request and again in the eventual commit predicate.
    if (!(await refreshSnapshotCurrent(db, job))) return { snapshot: null, finish, stale: true };
    if (!(await syncKeysetCurrent(sctx, job.credentialKeysetCommitment)))
      return { snapshot: null, finish, stale: true };
    if (!ref) return { snapshot: null, finish, stale: true };
    // The job names a pass version; the row_version of that same version is the write fence.
    const rowVersion = await passVersionRowVersion(db, job.passId, job.passVersion);
    if (rowVersion === undefined) return { snapshot: null, finish, stale: true };
    const result = await prep.def.fetchRecord(prep.cc, ref);
    recordsSeen = 1;
    applying = true;
    const applied = await applyIncoming(sctx, conn, ref, fromResult(result), {
      generation,
      credentialKeysetCommitment: job.credentialKeysetCommitment,
      cause: job.trigger === 'user' ? 'user_refresh' : 'connection',
      intervalMs: prep.intervalMs,
      retainedBinding: {
        kind: 'existing',
        snapshot: {
          passId: job.passId,
          orgId: job.orgId,
          mode: 'live',
          status: 'active',
          expectedVersion: job.passVersion,
          expectedRowVersion: rowVersion,
          identityId: job.identityId,
          credentialGeneration: job.credentialGeneration,
          lifecycleGeneration: job.lifecycleGeneration,
          credentialKeysetCommitment: job.credentialKeysetCommitment,
          transferPending: false,
          ownerUserId: job.ownerUserId,
          linkGeneration: job.linkGeneration,
          connectionId: conn.id,
          externalRef: ref,
          generation,
          expectedConnectionMode: connectionMode,
        },
        templateId: job.templateId,
        templateVersion: job.templateVersion,
        releaseId: job.releaseId,
        credentialKeysetCommitment: job.credentialKeysetCommitment,
      },
      passes: new Map([[ref, pass]]),
    });
    if (
      applied.outcome === 'fenced' ||
      applied.outcome === 'deferred' ||
      applied.outcome === 'unlinked' ||
      applied.identityId !== job.identityId ||
      applied.credentialGeneration !== job.credentialGeneration ||
      applied.lifecycleGeneration !== job.lifecycleGeneration ||
      applied.transferPending !== false ||
      applied.credentialKeysetCommitment !== job.credentialKeysetCommitment ||
      applied.templateId !== job.templateId ||
      applied.templateVersion !== job.templateVersion ||
      applied.releaseId !== job.releaseId ||
      typeof applied.pushQueued !== 'boolean'
    ) {
      if (applied.staleCode === 'STALE_GENERATION') staleCode = 'STALE_GENERATION';
      snapshot = null;
    } else {
      outcome =
        applied.outcome === 'invalid'
          ? 'error'
          : applied.outcome === 'changed' || applied.outcome === 'missing'
            ? 'changed'
            : 'unchanged';
      if (applied.outcome === 'invalid') errorCode = 'RECORD_INVALID';
      if (
        applied.version === undefined ||
        applied.status === undefined ||
        applied.ownerUserId === undefined ||
        applied.linkGeneration === undefined
      ) {
        snapshot = null;
      } else if (applied.pushQueued) {
        // The mutation already committed a durable push; only stamp its exact resulting state.
        if (!(await syncKeysetCurrent(sctx, job.credentialKeysetCommitment)))
          return { snapshot: null, finish, stale: true };
        const stamped = await markRefreshCompleted(
          sctx,
          {
            ...job,
            passVersion: applied.version,
            status: applied.status,
            ownerUserId: applied.ownerUserId,
            linkGeneration: applied.linkGeneration,
          },
          sctx.clock.now(),
        );
        return { snapshot: null, finish, stale: !stamped };
      } else if (
        applied.version !== job.passVersion ||
        applied.status !== job.status ||
        applied.ownerUserId !== job.ownerUserId ||
        applied.linkGeneration !== job.linkGeneration
      ) {
        // No push was committed: fence one to the exact state returned by this mutation.
        snapshot = {
          ...job,
          passVersion: applied.version,
          status: applied.status,
          ownerUserId: applied.ownerUserId,
          linkGeneration: applied.linkGeneration,
        };
      }
    }
  } catch (error) {
    if (error instanceof ConflictError) {
      sctx.log.info('connection.refresh_stale', { passId: pass.id, code: error.code });
      snapshot = null;
    } else {
      const failure = classify(error);
      if (failure.code === 'INTERNAL')
        sctx.log.error('connection.refresh_failed', { passId: pass.id, code: failure.code });
      outcome = 'error';
      errorCode = failure.code;
      httpStatus = failure.httpStatus;
      if (applying) snapshot = null;
    }
  }
  return { snapshot, finish, stale: snapshot === null };
}

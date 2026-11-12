import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import { type ConnectionReleaseSnapshot, captureConnectionRelease } from './records.ts';
import { type ConnectionRow, getConnection } from './repo.ts';
import { listDuePassRefs } from './repo-passes.ts';
import { insertRun, syncRunCurrent } from './repo-runs.ts';
import { advanceConnectionCursor, setWorkflowStatus } from './repo-sync.ts';
import { classify, type Failure } from './runtime.ts';
import { applyChanges, type Change } from './sync-apply.ts';
import {
  type StaleCode,
  type StepResult,
  stopped,
  syncContext,
  syncKeysetCurrent,
  tryPrepare,
} from './sync-context.ts';

export const MAX_PASSES_PER_RUN = 500;
export const MAX_PAGES_PER_RUN = 200;

/** Records applied per workflow step or webhook job; bounds D1 queries and CPU per invocation. */
export const MAX_RECORDS_PER_STEP = 20;

export type StartResult =
  | {
      ok: true;
      useList: boolean;
      cursor: string | null;
      startedAt: number;
      release: ConnectionReleaseSnapshot;
      mode: ConnectionRow['mode'];
      credentialKeysetCommitment: string;
    }
  | {
      ok: false;
      reason: 'GONE' | 'STALE_CONTEXT' | 'STALE_GENERATION' | 'ORG_INACTIVE' | Failure['code'];
      startedAt: number;
      credentialKeysetCommitment: string;
      mode?: ConnectionRow['mode'];
    };

export async function startRun(
  sctx: ServiceContext,
  p: {
    connectionId: string;
    orgId: string;
    runId: string;
    trigger: 'schedule' | 'webhook' | 'admin';
    generation: number;
    credentialKeysetCommitment: string;
    instanceId?: string;
  },
): Promise<StartResult> {
  const startedAt = sctx.clock.now();
  const credentialKeysetCommitment = p.credentialKeysetCommitment;
  if (
    (p.instanceId !== undefined && p.instanceId !== p.runId) ||
    !(await syncKeysetCurrent(sctx, credentialKeysetCommitment))
  )
    return { ok: false, reason: 'STALE_CONTEXT', startedAt, credentialKeysetCommitment };
  const conn = await getConnection(sctx.env.DB, p.connectionId);
  if (!conn) return { ok: false, reason: 'GONE', startedAt, credentialKeysetCommitment };
  if (
    !p.orgId ||
    conn.orgId !== p.orgId ||
    !conn.enabled ||
    !Number.isSafeInteger(p.generation) ||
    p.generation < 1 ||
    !Number.isSafeInteger(conn.generation) ||
    conn.generation < 1
  ) {
    return { ok: false, reason: 'STALE_CONTEXT', startedAt, credentialKeysetCommitment };
  }
  if (p.trigger === 'schedule' && conn.mode !== 'poll' && conn.mode !== 'hybrid')
    return { ok: false, reason: 'STALE_CONTEXT', startedAt, credentialKeysetCommitment };
  if (!(await isOrgActive(sctx, conn.orgId)))
    return { ok: false, reason: 'ORG_INACTIVE', startedAt, credentialKeysetCommitment };
  if (conn.generation !== p.generation)
    return { ok: false, reason: 'STALE_GENERATION', startedAt, credentialKeysetCommitment };
  const inserted = await insertRun(
    sctx,
    {
      id: p.runId,
      connectionId: conn.id,
      trigger: p.trigger,
      startedAt,
      expected: {
        orgId: p.orgId,
        generation: p.generation,
        mode: conn.mode,
        credentialKeysetCommitment,
        ...(p.instanceId === undefined ? {} : { workflowInstanceId: p.instanceId }),
      },
    },
    { orgId: p.orgId },
  );
  if (
    !inserted &&
    !(await syncRunCurrent(sctx.env.DB, {
      runId: p.runId,
      connectionId: p.connectionId,
      orgId: p.orgId,
      trigger: p.trigger,
      generation: p.generation,
      mode: conn.mode,
      credentialKeysetCommitment,
    }))
  ) {
    return { ok: false, reason: 'STALE_CONTEXT', startedAt, credentialKeysetCommitment };
  }
  if (!(await syncKeysetCurrent(sctx, credentialKeysetCommitment))) {
    return { ok: false, reason: 'STALE_CONTEXT', startedAt, credentialKeysetCommitment };
  }
  const context = await syncContext(sctx, p.connectionId, p.orgId, p.generation, conn.mode);
  if (!context.conn) {
    return { ok: false, reason: context.staleCode, startedAt, credentialKeysetCommitment };
  }
  if (
    p.instanceId !== undefined &&
    !(await setWorkflowStatus(
      sctx.env.DB,
      p.instanceId,
      'running',
      startedAt,
      null,
      undefined,
      credentialKeysetCommitment,
      {
        orgId: p.orgId,
        connectionId: p.connectionId,
        runnable: { generation: p.generation, mode: conn.mode },
      },
    ))
  ) {
    return { ok: false, reason: 'STALE_CONTEXT', startedAt, credentialKeysetCommitment };
  }
  let release: ConnectionReleaseSnapshot;
  try {
    release = await captureConnectionRelease(sctx, conn);
  } catch (error) {
    // Back off and leave the cursor untouched if approved content is no longer intact.
    if (error instanceof AppError && error.code === 'TEMPLATE_CONTENT_CHANGED')
      return {
        ok: false,
        reason: 'INTERNAL',
        startedAt,
        mode: conn.mode,
        credentialKeysetCommitment,
      };
    throw error;
  }
  const prep = await tryPrepare(sctx, conn);
  if ('code' in prep)
    return { ok: false, reason: prep.code, startedAt, mode: conn.mode, credentialKeysetCommitment };
  return {
    ok: true,
    useList:
      Boolean(prep.def.listChanges) && (prep.def.hasList?.(prep.cc.connection.config) ?? true),
    cursor: conn.cursor,
    release,
    mode: conn.mode,
    credentialKeysetCommitment,
    startedAt,
  };
}

export type PageFetch =
  | { ok: true; changes: Change[]; cursor: string | null; hasMore: boolean }
  | { ok: false; result: StepResult };

/** The listChanges request for one page. Applying and the cursor move are separate steps. */
export async function fetchListPage(
  sctx: ServiceContext,
  p: {
    connectionId: string;
    orgId: string;
    generation: number;
    mode: ConnectionRow['mode'];
    cursor: string | null;
    credentialKeysetCommitment: string;
  },
): Promise<PageFetch> {
  if (!(await syncKeysetCurrent(sctx, p.credentialKeysetCommitment)))
    return { ok: false, result: stopped(null, true, p.cursor) };
  const context = await syncContext(sctx, p.connectionId, p.orgId, p.generation, p.mode);
  if (!context.conn) return { ok: false, result: stopped(null, true, p.cursor, context.staleCode) };
  const conn = context.conn;
  const prep = await tryPrepare(sctx, conn);
  if ('code' in prep) return { ok: false, result: stopped(prep, false, p.cursor) };
  if (!prep.def.listChanges) {
    const failure: Failure = { code: 'CONFIG', httpStatus: null, retryAfterMs: null };
    return { ok: false, result: stopped(failure, false, p.cursor) };
  }
  if (!(await syncKeysetCurrent(sctx, p.credentialKeysetCommitment)))
    return { ok: false, result: stopped(null, true, p.cursor) };
  const current = await syncContext(sctx, p.connectionId, p.orgId, p.generation, p.mode);
  if (!current.conn) return { ok: false, result: stopped(null, true, p.cursor, current.staleCode) };
  try {
    const page = await prep.def.listChanges(prep.cc, p.cursor);
    return { ok: true, changes: page.changes, cursor: page.cursor, hasMore: page.hasMore };
  } catch (error) {
    return { ok: false, result: stopped(classify(error), false, p.cursor) };
  }
}

/** Applies one slice of a page. */
export async function applySlice(
  sctx: ServiceContext,
  p: {
    connectionId: string;
    orgId: string;
    generation: number;
    mode: ConnectionRow['mode'];
    changes: Change[];
    release: ConnectionReleaseSnapshot;
    credentialKeysetCommitment: string;
  },
): Promise<StepResult> {
  if (!(await syncKeysetCurrent(sctx, p.credentialKeysetCommitment)))
    return stopped(null, true, null);
  const context = await syncContext(sctx, p.connectionId, p.orgId, p.generation, p.mode);
  if (!context.conn) return stopped(null, true, null, context.staleCode);
  const conn = context.conn;
  const prep = await tryPrepare(sctx, conn);
  if ('code' in prep) return stopped(prep, false, null);
  const { totals, failure, samples, stale, staleCode, releaseBlocked } = await applyChanges(
    sctx,
    conn,
    prep,
    p.changes,
    p.release,
    undefined,
    p.credentialKeysetCommitment,
  );
  return {
    ...totals,
    failure,
    stale,
    ...(stale ? { staleCode: staleCode ?? ('STALE_CONTEXT' as const) } : {}),
    ...(releaseBlocked ? { releaseBlocked } : {}),
    cursor: null,
    hasMore: false,
    samples,
  };
}

/** The cursor advances only after the whole page was handled without stale or blocked work. */
export async function advanceCursor(
  sctx: ServiceContext,
  p: {
    connectionId: string;
    orgId: string;
    generation: number;
    mode: ConnectionRow['mode'];
    cursor: string | null;
    credentialKeysetCommitment: string;
  },
): Promise<{ stale: boolean; staleCode?: StaleCode }> {
  if (!(await syncKeysetCurrent(sctx, p.credentialKeysetCommitment)))
    return { stale: true, staleCode: 'STALE_CONTEXT' };
  const context = await syncContext(sctx, p.connectionId, p.orgId, p.generation, p.mode);
  if (!context.conn) return { stale: true, staleCode: context.staleCode };
  return (await advanceConnectionCursor(sctx, p))
    ? { stale: false }
    : { stale: true, staleCode: 'STALE_CONTEXT' };
}

/** Refs of linked passes due for a refresh (connectors without listChanges). */
export async function dueRefs(
  sctx: ServiceContext,
  p: {
    connectionId: string;
    orgId: string;
    generation: number;
    mode: ConnectionRow['mode'];
    credentialKeysetCommitment: string;
  },
): Promise<{ refs: string[] | null; staleCode?: StaleCode }> {
  if (!(await syncKeysetCurrent(sctx, p.credentialKeysetCommitment)))
    return { refs: null, staleCode: 'STALE_CONTEXT' };
  const context = await syncContext(sctx, p.connectionId, p.orgId, p.generation, p.mode);
  if (!context.conn) return { refs: null, staleCode: context.staleCode };
  return {
    refs: await listDuePassRefs(
      sctx.env.DB,
      context.conn.orgId,
      context.conn.id,
      sctx.clock.now(),
      MAX_PASSES_PER_RUN,
    ),
  };
}

import type { UpstreamRecord } from '../../connectors/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { run } from '../../platform/db.ts';
import { isOrgActive } from '../orgs/active.ts';
import { getDeps } from './deps.ts';
import {
  addOutcome,
  applyIncoming,
  type Applied,
  emptyTotals,
  fromResult,
  type Incoming,
  type Totals,
} from './records.ts';
import { type ConnectionRow, getConnection } from './repo.ts';
import { hasBinding, listDuePassRefs, listPassesByRefs, type SyncPass } from './repo-passes.ts';
import { insertRun } from './repo-runs.ts';
import { setWorkflowStatus } from './repo-sync.ts';
import { classify, type Failure, type Prepared, paceMs, prepare } from './runtime.ts';

export const MAX_PASSES_PER_RUN = 500;
export const MAX_PAGES_PER_RUN = 200;

export interface StepResult extends Totals {
  /** Set when the connector failed; the run stops and passes are left untouched. */
  failure: Failure | null;
  /** The run or a captured pass changed since the work started. */
  stale: boolean;
  staleCode?: 'STALE_CONTEXT';
  cursor: string | null;
  hasMore: boolean;
  /** First failing records (ref, code, validator message). */
  samples: string[];
}

const stopped = (failure: Failure | null, stale: boolean, cursor: string | null): StepResult => ({
  ...emptyTotals(),
  failure,
  stale,
  cursor,
  hasMore: false,
  samples: [],
});

/** Records applied per workflow step or webhook job; bounds D1 queries and CPU per invocation. */
export const MAX_RECORDS_PER_STEP = 20;

async function tryPrepare(sctx: ServiceContext, conn: ConnectionRow): Promise<Prepared | Failure> {
  try {
    return await prepare(sctx, conn);
  } catch (error) {
    return classify(error);
  }
}

/** Returns the connection if it is still runnable at `generation`, else null. */
async function live(
  sctx: ServiceContext,
  connectionId: string,
  orgId: string,
  generation: number,
): Promise<ConnectionRow | null> {
  const conn = await getConnection(sctx.env.DB, connectionId);
  return orgId && conn?.enabled && conn.orgId === orgId &&
    conn.generation === generation && await isOrgActive(sctx, orgId)
    ? conn
    : null;
}

export type StartResult =
  | { ok: true; useList: boolean; cursor: string | null; startedAt: number }
  | {
      ok: false;
      reason: 'GONE' | 'STALE_GENERATION' | 'ORG_INACTIVE' | Failure['code'];
      startedAt: number;
    };

export async function startRun(
  sctx: ServiceContext,
  p: {
    connectionId: string;
    orgId: string;
    runId: string;
    trigger: 'schedule' | 'webhook' | 'admin';
    generation: number;
    instanceId?: string;
  },
): Promise<StartResult> {
  const startedAt = sctx.clock.now();
  const conn = await getConnection(sctx.env.DB, p.connectionId);
  if (!conn) return { ok: false, reason: 'GONE', startedAt };
  if (!p.orgId || conn.orgId !== p.orgId || !conn.enabled ||
      !Number.isInteger(p.generation) || conn.generation !== p.generation) {
    return { ok: false, reason: 'STALE_GENERATION', startedAt };
  }
  if (!(await isOrgActive(sctx, conn.orgId)))
    return { ok: false, reason: 'ORG_INACTIVE', startedAt };
  await insertRun(sctx.env.DB, {
    id: p.runId,
    connectionId: conn.id,
    trigger: p.trigger,
    startedAt,
    expected: { orgId: p.orgId, generation: p.generation },
  });
  if (!(await live(sctx, p.connectionId, p.orgId, p.generation))) {
    return { ok: false, reason: 'STALE_GENERATION', startedAt };
  }
  if (p.instanceId) await setWorkflowStatus(sctx.env.DB, p.instanceId, 'running', startedAt);
  const prep = await tryPrepare(sctx, conn);
  if ('code' in prep) return { ok: false, reason: prep.code, startedAt };
  return {
    ok: true,
    useList:
      Boolean(prep.def.listChanges) && (prep.def.hasList?.(prep.cc.connection.config) ?? true),
    cursor: conn.cursor,
    startedAt,
  };
}

export type Change = { ref: string; record?: UpstreamRecord | undefined; deleted?: boolean };

/** Pauses between batches so the average request rate stays within the per-minute budget. */
async function inBatches<T>(
  items: T[],
  prep: Prepared,
  fn: (item: T) => Promise<void>,
  isRequest: (item: T) => boolean,
): Promise<void> {
  const { sleep } = getDeps();
  for (let i = 0; i < items.length; i += prep.maxConcurrency) {
    const batch = items.slice(i, i + prep.maxConcurrency);
    await Promise.all(batch.map(fn));
    const requests = batch.filter(isRequest).length;
    if (requests > 0 && i + prep.maxConcurrency < items.length) {
      await sleep(paceMs(requests, prep.requestsPerMinute));
    }
  }
}

interface ApplyExtra {
  passes: Map<string, SyncPass | null>;
  samples: string[];
  stale: boolean;
}

const MAX_SAMPLES = 5;
function recordOutcome(totals: Totals, extra: ApplyExtra, result: Applied): void {
  addOutcome(totals, result.outcome);
  if (result.outcome === 'fenced' || result.outcome === 'deferred') extra.stale = true;
}

/** One query per 90 refs instead of one per record. */
async function prefetchPasses(
  sctx: ServiceContext,
  conn: ConnectionRow,
  refs: string[],
): Promise<Map<string, SyncPass | null>> {
  const found = await listPassesByRefs(sctx.env.DB, conn.orgId, conn.id, refs);
  return new Map(refs.map((ref) => [ref, found.get(ref) ?? null]));
}

async function fetchAndApply(
  sctx: ServiceContext,
  conn: ConnectionRow,
  prep: Prepared,
  ref: string,
  cause: 'connection' | 'user_refresh',
  totals: Totals,
  failures: { first: Failure | null },
  extra: ApplyExtra,
): Promise<void> {
  // A due pass may have been unbound, voided or moved into Test after the due query.
  if (!extra.passes.get(ref) &&
      (!conn.autoCreate || await hasBinding(sctx.env.DB, conn.orgId, conn.id, ref))) return;
  if (!(await live(sctx, conn.id, conn.orgId, conn.generation))) {
    extra.stale = true;
    return;
  }
  let result: Awaited<ReturnType<typeof prep.def.fetchRecord>>;
  try {
    result = await prep.def.fetchRecord(prep.cc, ref);
  } catch (error) {
    const failure = classify(error);
    // INVALID_PAYLOAD is about one record; everything else is about the connection.
    if (failure.code === 'INVALID_PAYLOAD') {
      totals.seen += 1;
      totals.errors += 1;
      if (extra.samples.length < MAX_SAMPLES) extra.samples.push(`${ref}: INVALID_PAYLOAD`);
    } else {
      failures.first ??= failure;
    }
    return;
  }
  // Seam failures other than record problems propagate so the step or job retries.
  recordOutcome(
    totals,
    extra,
    await applyIncoming(sctx, conn, ref, fromResult(result), {
      generation: conn.generation,
      cause,
      intervalMs: prep.intervalMs,
      ...extra,
    }),
  );
}

/** Embedded records and deletions are applied directly; bare refs are fetched. */
export async function applyChanges(
  sctx: ServiceContext,
  conn: ConnectionRow,
  prep: Prepared,
  changes: Change[],
): Promise<{ totals: Totals; failure: Failure | null; samples: string[]; stale: boolean }> {
  const totals = emptyTotals();
  const failures: { first: Failure | null } = { first: null };
  const extra: ApplyExtra = {
    passes: await prefetchPasses(
      sctx,
      conn,
      changes.map((c) => c.ref),
    ),
    samples: [],
    stale: false,
  };
  const options = {
    generation: conn.generation,
    cause: 'connection' as const,
    intervalMs: prep.intervalMs,
    ...extra,
  };
  await inBatches(
    changes,
    prep,
    async (change) => {
      if (change.deleted) {
        recordOutcome(
          totals,
          extra,
          await applyIncoming(sctx, conn, change.ref, { kind: 'missing' }, options),
        );
      } else if (change.record) {
        const incoming: Incoming = { kind: 'record', record: change.record };
        recordOutcome(totals, extra, await applyIncoming(sctx, conn, change.ref, incoming, options));
      } else {
        await fetchAndApply(sctx, conn, prep, change.ref, 'connection', totals, failures, extra);
      }
    },
    (c) => !c.deleted && !c.record,
  );
  return { totals, failure: failures.first, samples: extra.samples, stale: extra.stale };
}

export type PageFetch =
  | { ok: true; changes: Change[]; cursor: string | null; hasMore: boolean }
  | { ok: false; result: StepResult };

/** The listChanges request for one page. Applying and the cursor move are separate steps. */
export async function fetchListPage(
  sctx: ServiceContext,
  p: { connectionId: string; orgId: string; generation: number; cursor: string | null },
): Promise<PageFetch> {
  const conn = await live(sctx, p.connectionId, p.orgId, p.generation);
  if (!conn) return { ok: false, result: stopped(null, true, p.cursor) };
  const prep = await tryPrepare(sctx, conn);
  if ('code' in prep) return { ok: false, result: stopped(prep, false, p.cursor) };
  if (!prep.def.listChanges) {
    const failure: Failure = { code: 'CONFIG', httpStatus: null, retryAfterMs: null };
    return { ok: false, result: stopped(failure, false, p.cursor) };
  }
  if (!(await live(sctx, p.connectionId, p.orgId, p.generation))) {
    return { ok: false, result: stopped(null, true, p.cursor) };
  }
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
  p: { connectionId: string; orgId: string; generation: number; changes: Change[] },
): Promise<StepResult> {
  const conn = await live(sctx, p.connectionId, p.orgId, p.generation);
  if (!conn) return stopped(null, true, null);
  const prep = await tryPrepare(sctx, conn);
  if ('code' in prep) return stopped(prep, false, null);
  const { totals, failure, samples, stale } = await applyChanges(sctx, conn, prep, p.changes);
  return { ...totals, failure, stale, ...(stale ? { staleCode: 'STALE_CONTEXT' as const } : {}), cursor: null, hasMore: false, samples };
}

/** The cursor only advances once the whole page was handled; a stale run leaves it alone. */
export async function advanceCursor(
  sctx: ServiceContext,
  p: { connectionId: string; orgId: string; generation: number; cursor: string | null },
): Promise<{ stale: boolean }> {
  const result = await run(
    sctx.env.DB,
    `UPDATE connections SET cursor = ? WHERE id = ? AND org_id = ? AND generation = ? AND enabled = 1
       AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = connections.org_id AND o.status = 'active')`,
    [p.cursor, p.connectionId, p.orgId, p.generation],
  );
  return { stale: result.changes === 0 };
}

/** Refs of linked passes due for a refresh (connectors without listChanges). */
export async function dueRefs(
  sctx: ServiceContext,
  p: { connectionId: string; orgId: string; generation: number },
): Promise<string[] | null> {
  const conn = await live(sctx, p.connectionId, p.orgId, p.generation);
  if (!conn) return null;
  return listDuePassRefs(sctx.env.DB, conn.orgId, conn.id, sctx.clock.now(), MAX_PASSES_PER_RUN);
}

/** Fetches and applies one chunk of refs (at most maxConcurrency per workflow step). */
export async function runRefs(
  sctx: ServiceContext,
  p: { connectionId: string; orgId: string; generation: number; refs: string[] },
): Promise<StepResult> {
  const conn = await live(sctx, p.connectionId, p.orgId, p.generation);
  if (!conn) return stopped(null, true, null);
  const prep = await tryPrepare(sctx, conn);
  if ('code' in prep) return stopped(prep, false, null);
  const totals = emptyTotals();
  const failures: { first: Failure | null } = { first: null };
  const extra: ApplyExtra = {
    passes: await prefetchPasses(sctx, conn, p.refs),
    samples: [],
    stale: false,
  };
  await Promise.all(
    p.refs.map((ref) =>
      fetchAndApply(sctx, conn, prep, ref, 'connection', totals, failures, extra),
    ),
  );
  return {
    ...totals,
    failure: failures.first,
    stale: extra.stale,
    ...(extra.stale ? { staleCode: 'STALE_CONTEXT' as const } : {}),
    cursor: null,
    hasMore: false,
    samples: extra.samples,
  };
}

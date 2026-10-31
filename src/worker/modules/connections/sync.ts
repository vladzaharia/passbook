import type { UpstreamRecord } from '../../connectors/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getDeps } from './deps.ts';
import {
  addOutcome,
  applyIncoming,
  emptyTotals,
  fromResult,
  type Incoming,
  type Totals,
} from './records.ts';
import { type ConnectionRow, getConnection, patchConnection } from './repo.ts';
import { listDuePassRefs } from './repo-passes.ts';
import { insertRun } from './repo-runs.ts';
import { classify, type Failure, type Prepared, paceMs, prepare } from './runtime.ts';

export const MAX_PASSES_PER_RUN = 500;
export const MAX_PAGES_PER_RUN = 200;

export interface StepResult extends Totals {
  /** Set when the connector failed; the run stops and passes are left untouched. */
  failure: Failure | null;
  /** The connection changed since the run started. */
  stale: boolean;
  cursor: string | null;
  hasMore: boolean;
}

const stopped = (failure: Failure | null, stale: boolean, cursor: string | null): StepResult => ({
  ...emptyTotals(),
  failure,
  stale,
  cursor,
  hasMore: false,
});

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
  generation: number,
): Promise<ConnectionRow | null> {
  const conn = await getConnection(sctx.env.DB, connectionId);
  return conn?.enabled && conn.generation === generation ? conn : null;
}

export type StartResult =
  | { ok: true; useList: boolean; cursor: string | null; startedAt: number }
  | { ok: false; reason: 'GONE' | 'STALE_GENERATION' | Failure['code']; startedAt: number };

export async function startRun(
  sctx: ServiceContext,
  p: {
    connectionId: string;
    runId: string;
    trigger: 'schedule' | 'webhook' | 'admin';
    generation: number;
  },
): Promise<StartResult> {
  const startedAt = sctx.clock.now();
  const conn = await getConnection(sctx.env.DB, p.connectionId);
  if (!conn) return { ok: false, reason: 'GONE', startedAt };
  await insertRun(sctx.env.DB, {
    id: p.runId,
    connectionId: conn.id,
    trigger: p.trigger,
    startedAt,
  });
  if (!conn.enabled || conn.generation !== p.generation) {
    return { ok: false, reason: 'STALE_GENERATION', startedAt };
  }
  const prep = await tryPrepare(sctx, conn);
  if ('code' in prep) return { ok: false, reason: prep.code, startedAt };
  return { ok: true, useList: Boolean(prep.def.listChanges), cursor: conn.cursor, startedAt };
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

async function fetchAndApply(
  sctx: ServiceContext,
  conn: ConnectionRow,
  prep: Prepared,
  ref: string,
  cause: 'connection' | 'user_refresh',
  totals: Totals,
  failures: { first: Failure | null },
): Promise<void> {
  try {
    const result = await prep.def.fetchRecord(prep.cc, ref);
    addOutcome(
      totals,
      await applyIncoming(sctx, conn, ref, fromResult(result), {
        generation: conn.generation,
        cause,
        intervalMs: prep.intervalMs,
      }),
    );
  } catch (error) {
    const failure = classify(error);
    // INVALID_PAYLOAD is about one record; everything else is about the connection.
    if (failure.code === 'INVALID_PAYLOAD') {
      totals.seen += 1;
      totals.errors += 1;
    } else {
      failures.first ??= failure;
    }
  }
}

/** Embedded records and deletions are applied directly; bare refs are fetched. */
export async function applyChanges(
  sctx: ServiceContext,
  conn: ConnectionRow,
  prep: Prepared,
  changes: Change[],
): Promise<{ totals: Totals; failure: Failure | null }> {
  const totals = emptyTotals();
  const failures: { first: Failure | null } = { first: null };
  const options = {
    generation: conn.generation,
    cause: 'connection' as const,
    intervalMs: prep.intervalMs,
  };
  await inBatches(
    changes,
    prep,
    async (change) => {
      if (change.deleted) {
        addOutcome(
          totals,
          await applyIncoming(sctx, conn, change.ref, { kind: 'missing' }, options),
        );
      } else if (change.record) {
        const incoming: Incoming = { kind: 'record', record: change.record };
        addOutcome(totals, await applyIncoming(sctx, conn, change.ref, incoming, options));
      } else {
        await fetchAndApply(sctx, conn, prep, change.ref, 'connection', totals, failures);
      }
    },
    (c) => !c.deleted && !c.record,
  );
  return { totals, failure: failures.first };
}

/** One page of listChanges. */
export async function runListPage(
  sctx: ServiceContext,
  p: { connectionId: string; generation: number; cursor: string | null },
): Promise<StepResult> {
  const conn = await live(sctx, p.connectionId, p.generation);
  if (!conn) return stopped(null, true, p.cursor);
  const prep = await tryPrepare(sctx, conn);
  if ('code' in prep) return stopped(prep, false, p.cursor);
  if (!prep.def.listChanges)
    return stopped({ code: 'CONFIG', httpStatus: null, retryAfterMs: null }, false, p.cursor);
  let page: Awaited<ReturnType<NonNullable<typeof prep.def.listChanges>>>;
  try {
    page = await prep.def.listChanges(prep.cc, p.cursor);
  } catch (error) {
    return stopped(classify(error), false, p.cursor);
  }
  const { totals, failure } = await applyChanges(sctx, conn, prep, page.changes);
  if (failure) return { ...totals, failure, stale: false, cursor: p.cursor, hasMore: false };
  // The cursor only advances when the whole page was handled; a stale run leaves it alone.
  const advanced = await patchConnection(
    sctx.env.DB,
    conn.id,
    { cursor: page.cursor },
    p.generation,
  );
  return {
    ...totals,
    failure: null,
    stale: advanced === 0,
    cursor: page.cursor,
    hasMore: page.hasMore && advanced > 0,
  };
}

/** Refs of linked passes due for a refresh (connectors without listChanges). */
export async function dueRefs(
  sctx: ServiceContext,
  p: { connectionId: string; generation: number },
): Promise<string[] | null> {
  const conn = await live(sctx, p.connectionId, p.generation);
  if (!conn) return null;
  return listDuePassRefs(sctx.env.DB, conn.orgId, conn.id, sctx.clock.now(), MAX_PASSES_PER_RUN);
}

/** Fetches and applies one chunk of refs (at most maxConcurrency per workflow step). */
export async function runRefs(
  sctx: ServiceContext,
  p: { connectionId: string; generation: number; refs: string[] },
): Promise<StepResult> {
  const conn = await live(sctx, p.connectionId, p.generation);
  if (!conn) return stopped(null, true, null);
  const prep = await tryPrepare(sctx, conn);
  if ('code' in prep) return stopped(prep, false, null);
  const totals = emptyTotals();
  const failures: { first: Failure | null } = { first: null };
  await Promise.all(
    p.refs.map((ref) => fetchAndApply(sctx, conn, prep, ref, 'connection', totals, failures)),
  );
  return { ...totals, failure: failures.first, stale: false, cursor: null, hasMore: false };
}

import type { ServiceContext } from '../../platform/service-context.ts';
import { type ConnectionReleaseSnapshot, emptyTotals } from './records.ts';
import type { ConnectionRow } from './repo.ts';
import { sameSyncPass } from './repo-pass-snapshot.ts';
import { listPassesByRefs, type SyncPass } from './repo-passes.ts';
import type { Failure } from './runtime.ts';
import {
  type StepResult,
  stopped,
  syncContext,
  syncKeysetCurrent,
  tryPrepare,
} from './sync-context.ts';
import {
  type ApplyExtra,
  fetchAndApply,
  markStale,
  prefetchPasses,
  stalePassCode,
} from './sync-fetch.ts';

/** Fetches and applies one chunk of refs (at most maxConcurrency per workflow step). */
export async function runRefs(
  sctx: ServiceContext,
  p: {
    connectionId: string;
    orgId: string;
    generation: number;
    mode: ConnectionRow['mode'];
    refs: string[];
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
  const totals = emptyTotals();
  const failures: { first: Failure | null } = { first: null };
  if (!(await syncKeysetCurrent(sctx, p.credentialKeysetCommitment)))
    return stopped(null, true, null);
  const credentialKeysetCommitment = p.credentialKeysetCommitment;
  const extra: ApplyExtra = {
    passes: await prefetchPasses(sctx, conn, p.refs),
    samples: [],
    stale: false,
    release: p.release,
    credentialKeysetCommitment,
  };
  const existingRefs = p.refs.filter((ref) => extra.passes.get(ref));
  const current = existingRefs.length
    ? await listPassesByRefs(sctx.env.DB, conn.orgId, conn.id, existingRefs)
    : new Map<string, SyncPass>();
  const results = await Promise.allSettled(
    p.refs.map((ref) => {
      const original = extra.passes.get(ref);
      if (original && !sameSyncPass(original, current.get(ref))) {
        markStale(extra, stalePassCode(original, current.get(ref)));
        return null;
      }
      return fetchAndApply(sctx, conn, prep, ref, 'connection', totals, failures, extra);
    }),
  );
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected) throw rejected.reason;
  return {
    ...totals,
    failure: failures.first,
    stale: extra.stale,
    ...(extra.stale ? { staleCode: extra.staleCode ?? ('STALE_CONTEXT' as const) } : {}),
    ...(extra.releaseBlocked ? { releaseBlocked: extra.releaseBlocked } : {}),
    cursor: null,
    hasMore: false,
    samples: extra.samples,
  };
}

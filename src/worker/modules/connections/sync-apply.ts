import type { UpstreamRecord } from '../../connectors/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getDeps } from './deps.ts';
import type { Incoming } from './record-helpers.ts';
import {
  applyIncoming,
  type ConnectionReleaseSnapshot,
  emptyTotals,
  type ReleaseBlockCode,
  ReleaseContentRetryError,
  type Totals,
} from './records.ts';
import type { ConnectionRow } from './repo.ts';
import { sameSyncPass } from './repo-pass-snapshot.ts';
import { listPassesByRefs } from './repo-passes.ts';
import { type Failure, type Prepared, paceMs } from './runtime.ts';
import { type StaleCode, syncKeysetCurrent } from './sync-context.ts';
import {
  type ApplyExtra,
  type ChangeItemResult,
  fetchAndApply,
  markStale,
  prefetchPasses,
  recordOutcome,
  stalePassCode,
} from './sync-fetch.ts';
import {
  type ObservedClaim,
  type RetainedItemOptions,
  retainedCandidate,
  retainedOptions,
} from './sync-retained.ts';
import type { RetainedWebhookCandidate } from './webhook-retention-items.ts';

export { runRefs } from './sync-refs.ts';

export type Change = { ref: string; record?: UpstreamRecord | undefined; deleted?: boolean };
export type ChangeItemOutcome = 'success' | 'blocked' | 'retry' | 'failed' | 'uncertain';

/** Durable per-item claims use the original changes-array ordinal, including duplicate refs. */
export interface ChangeObserver {
  /** Legacy processing may only claim the originally admitted pass. */
  begin(index: number, candidate: RetainedWebhookCandidate): Promise<ObservedClaim | null>;
  finish(index: number, token: string, outcome: ChangeItemOutcome, code?: string): Promise<void>;
}

/** Pauses between batches so the average request rate stays within the per-minute budget. */
async function inBatches<T>(
  items: T[],
  prep: Prepared,
  fn: (item: T, index: number) => Promise<void>,
  isRequest: (item: T) => boolean,
  beforeBatch?: (batch: T[]) => Promise<void>,
): Promise<void> {
  const { sleep } = getDeps();
  for (let i = 0; i < items.length; i += prep.maxConcurrency) {
    const batch = items.slice(i, i + prep.maxConcurrency);
    if (beforeBatch) await beforeBatch(batch);
    const results = await Promise.allSettled(batch.map((item, index) => fn(item, i + index)));
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
    const requests = batch.filter(isRequest).length;
    if (requests > 0 && i + prep.maxConcurrency < items.length) {
      await sleep(paceMs(requests, prep.requestsPerMinute));
    }
  }
}

export interface ApplyChangesResult {
  totals: Totals;
  failure: Failure | null;
  samples: string[];
  stale: boolean;
  staleCode?: StaleCode;
  releaseBlocked?: ReleaseBlockCode;
  /** This blocked attempt completed without any pass effects or partial failures. */
  effectFree: boolean;
}

async function finishObservedChange(
  observer: ChangeObserver,
  index: number,
  token: string,
  result: ChangeItemResult,
  ref: string,
  extra: ApplyExtra,
): Promise<void> {
  if (typeof result === 'string') {
    await observer.finish(index, token, result);
  } else if ('outcome' in result) {
    if (result.outcome === 'release_blocked') {
      const proven =
        result.effectFree === true && extra.release?.kind === 'blocked' && !extra.passes.get(ref);
      await observer.finish(index, token, proven ? 'blocked' : 'uncertain', result.releaseBlocked);
    } else if (
      (result.outcome === 'fenced' || result.outcome === 'deferred') &&
      result.effectFree === true
    ) {
      // Lost before any effect: the item goes back to pending and the job retries it.
      await observer.finish(index, token, 'retry');
    } else if (
      result.outcome === 'invalid' ||
      result.outcome === 'fenced' ||
      result.outcome === 'deferred'
    ) {
      await observer.finish(index, token, 'uncertain');
    } else {
      await observer.finish(index, token, 'success');
    }
  } else {
    await observer.finish(
      index,
      token,
      result.code === 'INVALID_PAYLOAD' ? 'failed' : 'retry',
      result.code,
    );
  }
}

/** Embedded records and deletions are applied directly; bare refs are fetched. */
export async function applyChanges(
  sctx: ServiceContext,
  conn: ConnectionRow,
  prep: Prepared,
  changes: Change[],
  release: ConnectionReleaseSnapshot,
  observer: ChangeObserver | undefined,
  credentialKeysetCommitment: string,
): Promise<ApplyChangesResult> {
  const totals = emptyTotals();
  const failures: { first: Failure | null } = { first: null };
  const workConn = conn;
  if (!(await syncKeysetCurrent(sctx, credentialKeysetCommitment))) {
    return {
      totals,
      failure: null,
      samples: [],
      stale: true,
      staleCode: 'STALE_CONTEXT',
      effectFree: false,
    };
  }
  const extra: ApplyExtra = {
    passes: await prefetchPasses(
      sctx,
      conn,
      changes.map((c) => c.ref),
    ),
    samples: [],
    stale: false,
    release,
    credentialKeysetCommitment,
  };
  const options = {
    generation: conn.generation,
    cause: 'connection' as const,
    intervalMs: prep.intervalMs,
    release,
    credentialKeysetCommitment,
    passes: extra.passes,
    samples: extra.samples,
  };
  const staleFetchRefs = new Map<string, StaleCode>();
  await inBatches(
    changes,
    prep,
    async (change, index) => {
      const pass = extra.passes.get(change.ref);
      let token: string | null = null;
      let retained: RetainedItemOptions = {};
      if (observer) {
        const candidate = retainedCandidate(
          sctx,
          workConn,
          change,
          pass,
          release,
          credentialKeysetCommitment,
        );
        // The observer may retain or mutate its input; keep our proposal independent.
        const offered: RetainedWebhookCandidate =
          candidate.kind === 'existing'
            ? { ...candidate, snapshot: { ...candidate.snapshot } }
            : candidate.kind === 'new'
              ? {
                  ...candidate,
                  expectedRelease: candidate.expectedRelease
                    ? { ...candidate.expectedRelease }
                    : null,
                }
              : { ...candidate };
        const claim = await observer.begin(index, offered);
        if (!claim) return;
        token = claim.token;
        if (typeof token !== 'string' || !token) {
          markStale(extra);
          return;
        }
        const admitted = retainedOptions(workConn, change, pass, candidate, claim, index);
        if (!admitted) {
          markStale(extra);
          await observer.finish(index, token, 'uncertain');
          return;
        }
        retained = admitted;
      } else if (pass && pass.credentialKeysetCommitment !== credentialKeysetCommitment) {
        markStale(extra);
        return;
      } else if (!change.deleted && !change.record && staleFetchRefs.has(change.ref)) {
        markStale(extra, staleFetchRefs.get(change.ref));
        return;
      }
      const itemOptions = { ...options, ...retained };
      let result: ChangeItemResult;
      try {
        if (change.deleted) {
          result = await applyIncoming(
            sctx,
            workConn,
            change.ref,
            { kind: 'missing' },
            itemOptions,
          );
          recordOutcome(totals, extra, result);
        } else if (change.record) {
          const incoming: Incoming = { kind: 'record', record: change.record };
          result = await applyIncoming(sctx, workConn, change.ref, incoming, itemOptions);
          recordOutcome(totals, extra, result);
        } else {
          result = await fetchAndApply(
            sctx,
            workConn,
            prep,
            change.ref,
            'connection',
            totals,
            failures,
            extra,
            retained,
          );
        }
      } catch (error) {
        if (observer && token !== null) {
          if (error instanceof ReleaseContentRetryError) {
            await observer.finish(index, token, 'retry', error.code);
          } else {
            await observer.finish(index, token, 'uncertain');
          }
        }
        throw error;
      }
      if (observer && token !== null) {
        await finishObservedChange(observer, index, token, result, change.ref, extra);
      }
    },
    (c) => !c.deleted && !c.record,
    observer
      ? undefined
      : async (batch) => {
          const refs = batch
            .filter((change) => !change.deleted && !change.record && extra.passes.get(change.ref))
            .map((change) => change.ref);
          staleFetchRefs.clear();
          if (!refs.length) return;
          const current = await listPassesByRefs(sctx.env.DB, conn.orgId, conn.id, refs);
          for (const ref of refs) {
            const original = extra.passes.get(ref);
            const fresh = current.get(ref);
            if (original && !sameSyncPass(original, fresh))
              staleFetchRefs.set(ref, stalePassCode(original, fresh));
          }
        },
  );
  let effectFree =
    release?.kind === 'blocked' &&
    Boolean(extra.releaseBlocked) &&
    !failures.first &&
    !extra.stale &&
    !extra.unprovenRelease &&
    totals.errors === 0 &&
    totals.changed === 0 &&
    totals.created === 0 &&
    totals.missing === 0;
  if (effectFree) {
    for (const pass of extra.passes.values()) {
      if (pass) {
        effectFree = false;
        break;
      }
    }
  }
  return {
    totals,
    failure: failures.first,
    samples: extra.samples,
    stale: extra.stale,
    ...(extra.stale ? { staleCode: extra.staleCode ?? ('STALE_CONTEXT' as const) } : {}),
    effectFree,
    ...(extra.releaseBlocked ? { releaseBlocked: extra.releaseBlocked } : {}),
  };
}

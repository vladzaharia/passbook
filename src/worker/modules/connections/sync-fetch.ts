import type { RecordResult } from '../../connectors/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { fromResult, MAX_SAMPLES } from './record-helpers.ts';
import {
  type Applied,
  addOutcome,
  applyIncoming,
  type ConnectionReleaseSnapshot,
  type ReleaseBlockCode,
  type Totals,
} from './records.ts';
import type { ConnectionRow } from './repo.ts';
import { validSyncEpochs } from './repo-pass-snapshot.ts';
import {
  hasBinding,
  listPassesByRefs,
  type SyncPass,
  validPassReleaseBinding,
} from './repo-passes.ts';
import { classify, type Failure, type Prepared } from './runtime.ts';
import { type StaleCode, syncContext } from './sync-context.ts';
import type { RetainedItemOptions } from './sync-retained.ts';

export interface ApplyExtra {
  passes: Map<string, SyncPass | null>;
  samples: string[];
  stale: boolean;
  staleCode?: StaleCode;
  release: ConnectionReleaseSnapshot;
  credentialKeysetCommitment: string;
  releaseBlocked?: ReleaseBlockCode;
  unprovenRelease?: boolean;
}

export type ChangeItemResult = Applied | Failure | 'success' | 'uncertain';

export function markStale(extra: ApplyExtra, code: StaleCode = 'STALE_CONTEXT'): void {
  extra.stale = true;
  if (extra.staleCode !== 'STALE_CONTEXT') extra.staleCode = code;
}

/** Only matching pass identities with a known changed credential/lifecycle epoch prove drift. */
export function stalePassCode(expected: SyncPass, current: SyncPass | null | undefined): StaleCode {
  if (
    !current ||
    !validSyncEpochs(expected) ||
    typeof expected.id !== 'string' ||
    !expected.id ||
    typeof expected.orgId !== 'string' ||
    !expected.orgId ||
    typeof expected.identityId !== 'string' ||
    !expected.identityId ||
    typeof expected.connectionId !== 'string' ||
    !expected.connectionId ||
    typeof expected.externalRef !== 'string' ||
    !expected.externalRef ||
    !validPassReleaseBinding(expected) ||
    !validPassReleaseBinding(current) ||
    !Number.isSafeInteger(expected.version) ||
    expected.version < 1 ||
    !Number.isSafeInteger(current.version) ||
    current.version < 1 ||
    !Number.isSafeInteger(expected.linkGeneration) ||
    expected.linkGeneration < 1 ||
    !Number.isSafeInteger(current.linkGeneration) ||
    current.linkGeneration < 1 ||
    (expected.ownerUserId !== null && typeof expected.ownerUserId !== 'string') ||
    (current.ownerUserId !== null && typeof current.ownerUserId !== 'string') ||
    expected.mode !== 'live' ||
    expected.status !== 'active' ||
    expected.deletedAt !== null ||
    expected.removedAt !== null ||
    current.deletedAt !== null ||
    current.removedAt !== null ||
    current.id !== expected.id ||
    current.orgId !== expected.orgId ||
    current.mode !== expected.mode ||
    current.status !== expected.status ||
    current.identityId !== expected.identityId ||
    current.connectionId !== expected.connectionId ||
    current.externalRef !== expected.externalRef ||
    current.credentialKeysetCommitment !== expected.credentialKeysetCommitment ||
    current.templateId !== expected.templateId ||
    current.releaseId !== expected.releaseId ||
    current.templateVersion !== expected.templateVersion ||
    typeof current.transferPending !== 'boolean' ||
    !Number.isSafeInteger(current.credentialGeneration) ||
    current.credentialGeneration < 1 ||
    !Number.isSafeInteger(current.lifecycleGeneration) ||
    current.lifecycleGeneration < 0
  ) {
    return 'STALE_CONTEXT';
  }
  return current.credentialGeneration !== expected.credentialGeneration ||
    current.lifecycleGeneration !== expected.lifecycleGeneration
    ? 'STALE_GENERATION'
    : 'STALE_CONTEXT';
}

export function recordOutcome(totals: Totals, extra: ApplyExtra, result: Applied): void {
  addOutcome(totals, result.outcome);
  if (result.outcome === 'fenced' || result.outcome === 'deferred') {
    markStale(
      extra,
      result.staleCode === 'STALE_GENERATION' ? 'STALE_GENERATION' : 'STALE_CONTEXT',
    );
  }
  if (result.outcome === 'release_blocked') {
    if (!result.releaseBlocked) throw new Error('Missing release block code');
    extra.releaseBlocked ??= result.releaseBlocked;
    if (!result.effectFree) extra.unprovenRelease = true;
  }
}

/** Prefetch once per chunk, including absent refs. */
export async function prefetchPasses(
  sctx: ServiceContext,
  conn: ConnectionRow,
  refs: string[],
): Promise<Map<string, SyncPass | null>> {
  const found = await listPassesByRefs(sctx.env.DB, conn.orgId, conn.id, refs);
  return new Map(refs.map((ref) => [ref, found.get(ref) ?? null]));
}

export async function fetchAndApply(
  sctx: ServiceContext,
  conn: ConnectionRow,
  prep: Prepared,
  ref: string,
  cause: 'connection' | 'user_refresh',
  totals: Totals,
  failures: { first: Failure | null },
  extra: ApplyExtra,
  retained: RetainedItemOptions = {},
): Promise<ChangeItemResult> {
  const pass = extra.passes.get(ref);
  if (
    (pass &&
      (typeof pass.identityId !== 'string' ||
        !pass.identityId ||
        !validSyncEpochs(pass) ||
        pass.credentialKeysetCommitment !== extra.credentialKeysetCommitment)) ||
    (!pass && retained.retainedBinding) ||
    (pass && retained.retainedReservedPassId)
  ) {
    markStale(extra);
    return 'uncertain';
  }
  // A due pass may have been unbound, voided or moved into Test after the due query.
  if (!pass && (!conn.autoCreate || (await hasBinding(sctx.env.DB, conn.orgId, conn.id, ref)))) {
    if (retained.retainedReservedPassId) {
      markStale(extra);
      return 'uncertain';
    }
    return 'success';
  }
  const context = await syncContext(sctx, conn.id, conn.orgId, conn.generation, conn.mode);
  if (!context.conn) {
    markStale(extra, context.staleCode);
    return 'uncertain';
  }
  let result: RecordResult;
  try {
    result = await prep.def.fetchRecord(prep.cc, ref);
  } catch (error) {
    const failure = classify(error);
    if (failure.code === 'INVALID_PAYLOAD') {
      totals.seen += 1;
      totals.errors += 1;
      if (extra.samples.length < MAX_SAMPLES) extra.samples.push(`${ref}: INVALID_PAYLOAD`);
    } else {
      failures.first ??= failure;
    }
    return failure;
  }
  const applied = await applyIncoming(sctx, conn, ref, fromResult(result), {
    generation: conn.generation,
    cause,
    intervalMs: prep.intervalMs,
    release: extra.release,
    credentialKeysetCommitment: extra.credentialKeysetCommitment,
    passes: extra.passes,
    samples: extra.samples,
    ...retained,
  });
  recordOutcome(totals, extra, applied);
  return applied;
}

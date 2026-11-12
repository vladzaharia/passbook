import { PassBuildError } from '../../../passkit/build.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import type { RetainedIssuanceClaim } from '../passes/repo-write-retained.ts';
import { getDeps } from './deps.ts';
import { applyMapping } from './mapping.ts';
import {
  describeFailure,
  errorCode,
  holderEmailOf,
  type Incoming,
  MAX_SAMPLES,
} from './record-helpers.ts';
import {
  type ConnectionReleaseSnapshot,
  createIncomingPass,
  type ReleaseBlockCode,
} from './record-issuance.ts';
import {
  appliedSnapshot,
  markIncomingMissing,
  markIncomingSynced,
  mutationFence,
  releaseBlockCode,
} from './record-outcomes.ts';
import { captureRecordSnapshot } from './record-snapshot.ts';
import { type ConnectionRow, getConnection } from './repo.ts';
import { markPassSyncError, markPassSynced, type SyncSnapshot } from './repo-pass-snapshot.ts';
import { getPassByRef, type SyncPass, validCredentialKeysetCommitment } from './repo-passes.ts';

export type { ConnectionReleaseSnapshot, ReleaseBlockCode } from './record-issuance.ts';
export { captureConnectionRelease, ReleaseContentRetryError } from './record-issuance.ts';

export type Outcome =
  | 'changed'
  | 'unchanged'
  | 'created'
  | 'missing'
  | 'unlinked'
  | 'invalid'
  /** New issuance awaits an approved release or the captured release changed. */
  | 'release_blocked'
  /** Lost a publish race; the pass is untouched and stays due. */
  | 'deferred'
  /** The connection changed mid-step; nothing was written. */
  | 'fenced';

export interface Applied {
  outcome: Outcome;
  /** Only proven credential or lifecycle counter drift is classified as generation stale. */
  staleCode?: 'STALE_GENERATION' | 'STALE_CONTEXT';
  releaseBlocked?: ReleaseBlockCode;
  /** Decided before any pass mutation started (a release block, or a lost fence or CAS). */
  effectFree?: true;
  /** Version and status after a successful update of an existing pass. */
  version?: number;
  status?: 'active' | 'voided';
  identityId?: string;
  credentialGeneration?: number;
  lifecycleGeneration?: number;
  transferPending?: boolean;
  credentialKeysetCommitment?: string;
  templateId?: string;
  templateVersion?: string;
  releaseId?: string | null;
  /** A successful mutation already committed its own push. */
  pushQueued?: boolean;
  ownerUserId?: string | null;
  linkGeneration?: number;
}

/** The exact pass and release captured by a retained claim or refresh job. */
export interface RetainedPassBinding {
  kind: 'existing';
  snapshot: SyncSnapshot;
  templateId: string;
  releaseId: string | null;
  templateVersion: string;
  credentialKeysetCommitment: string;
}

export interface Totals {
  seen: number;
  changed: number;
  created: number;
  missing: number;
  errors: number;
}

export const emptyTotals = (): Totals => ({
  seen: 0,
  changed: 0,
  created: 0,
  missing: 0,
  errors: 0,
});

export function addOutcome(t: Totals, outcome: Outcome): void {
  t.seen += 1;
  if (outcome === 'changed') t.changed += 1;
  else if (outcome === 'created') t.created += 1;
  else if (outcome === 'missing') t.missing += 1;
  else if (outcome === 'invalid') t.errors += 1;
}

export interface ApplyIncomingOptions {
  generation: number;
  /** Keyset captured before any upstream fetch for this work. */
  credentialKeysetCommitment: string;
  cause: 'connection' | 'user_refresh';
  intervalMs: number;
  /** Release captured before this run fetched any upstream data. */
  release?: ConnectionReleaseSnapshot;
  retainedBinding?: RetainedPassBinding;
  /** Only a newly reserved, verified worker claim may supply this ID. */
  retainedReservedPassId?: string;
  retainedClaim?: RetainedIssuanceClaim;
  /** Passes prefetched for this batch, keyed by ref (null = none linked). */
  passes?: Map<string, SyncPass | null>;
  samples?: string[];
}

/**
 * Applies one upstream result against the snapshot taken before fetching it.
 * Bookkeeping is guarded by the same pass and connection context as publication.
 */
export async function applyIncoming(
  sctx: ServiceContext,
  conn: ConnectionRow,
  ref: string,
  incoming: Incoming,
  options: ApplyIncomingOptions,
): Promise<Applied> {
  // A pre-cutover ref that now resolves to missing is quarantined, not a deletion command.
  const deps = getDeps();
  const db = sctx.env.DB;
  if (
    !validCredentialKeysetCommitment(options.credentialKeysetCommitment) ||
    (await requireCredentialRefKeyset(db, sctx.env)) !== options.credentialKeysetCommitment
  ) {
    return { outcome: 'fenced' };
  }
  const now = sctx.clock.now();
  const nextSyncAt = now + options.intervalMs;
  const fenced = async (): Promise<boolean> => {
    if (conn.generation !== options.generation) return true;
    if ((await requireCredentialRefKeyset(db, sctx.env)) !== options.credentialKeysetCommitment)
      return true;
    const current = await getConnection(db, conn.id);
    return (
      !current?.enabled ||
      current.orgId !== conn.orgId ||
      current.mode !== conn.mode ||
      current.generation !== options.generation ||
      !(await isOrgActive(sctx, conn.orgId))
    );
  };
  const pass = options.passes?.has(ref)
    ? (options.passes.get(ref) ?? null)
    : await getPassByRef(db, conn.orgId, conn.id, ref);
  const snapshot = await captureRecordSnapshot(db, conn, ref, pass, options);
  // Nothing has been written until a mutation starts, so a loss before it is safe to retry.
  if (snapshot === 'STALE_GENERATION') {
    return (await fenced())
      ? { outcome: 'fenced', effectFree: true }
      : { outcome: 'fenced', staleCode: 'STALE_GENERATION', effectFree: true };
  }
  if (snapshot === undefined) return { outcome: 'fenced' };
  const preserveBinding = !!options.retainedBinding;

  if (await fenced()) return { outcome: 'fenced', effectFree: true };
  if (incoming.kind === 'unchanged') {
    return snapshot
      ? markIncomingSynced(sctx, snapshot, pass, now, nextSyncAt)
      : { outcome: 'unchanged' };
  }
  if (incoming.kind === 'missing') {
    const result = await markIncomingMissing(
      sctx,
      conn,
      snapshot,
      pass,
      now,
      nextSyncAt,
      preserveBinding,
    );
    return result.staleCode === 'STALE_GENERATION' && (await fenced())
      ? { outcome: 'fenced' }
      : result;
  }

  const fields = applyMapping(conn.mapping, incoming.record);
  const fail = async (error: unknown): Promise<Applied> => {
    if (!snapshot && (await fenced())) return { outcome: 'fenced' };
    if (
      snapshot &&
      (await requireCredentialRefKeyset(db, sctx.env)) !== options.credentialKeysetCommitment
    ) {
      return { outcome: 'fenced' };
    }
    const code = errorCode(error);
    if (snapshot && !(await markPassSyncError(sctx, { ...snapshot, code, nextSyncAt }))) {
      return { outcome: 'fenced' };
    }
    if (options.samples && options.samples.length < MAX_SAMPLES) {
      options.samples.push(describeFailure(ref, error));
    }
    sctx.log.warn('connection.record_invalid', { connectionId: conn.id, code });
    return snapshot ? appliedSnapshot('invalid', snapshot, pass) : { outcome: 'invalid' };
  };

  try {
    const holderEmail = holderEmailOf(conn, incoming);
    if (snapshot && pass) {
      const merged = { ...pass.personalization, ...fields } as Record<string, Json>;
      await deps.validateFields(
        sctx,
        { id: pass.templateId, version: pass.templateVersion },
        merged,
      );
      if (await fenced()) return { outcome: 'fenced', effectFree: true };
      const result = await deps.applyConnectionRecord(sctx, {
        ...snapshot,
        fields,
        holderEmail,
        cause: options.cause,
      });
      const fence = mutationFence(result, snapshot, pass, preserveBinding);
      if (fence) {
        return fence.staleCode === 'STALE_GENERATION' && (await fenced())
          ? { outcome: 'fenced' }
          : fence;
      }
      if (await fenced()) return { outcome: 'fenced' };
      const marked = await markPassSynced(sctx, {
        ...snapshot,
        expectedVersion: result.version,
        identityId: result.identityId,
        credentialGeneration: result.credentialGeneration,
        lifecycleGeneration: result.lifecycleGeneration,
        transferPending: result.transferPending,
        ownerUserId: result.ownerUserId,
        linkGeneration: result.linkGeneration,
        now,
        nextSyncAt,
      });
      if (!marked) return { outcome: 'fenced' };
      return {
        outcome: result.changed ? 'changed' : 'unchanged',
        version: result.version,
        status: 'active',
        identityId: result.identityId,
        credentialGeneration: result.credentialGeneration,
        lifecycleGeneration: result.lifecycleGeneration,
        transferPending: result.transferPending,
        credentialKeysetCommitment: result.credentialKeysetCommitment,
        templateId: result.templateId,
        templateVersion: result.templateVersion,
        releaseId: result.releaseId,
        pushQueued: result.pushQueued,
        ownerUserId: result.ownerUserId,
        linkGeneration: result.linkGeneration,
      };
    }
    return await createIncomingPass(
      sctx,
      conn,
      ref,
      options,
      fields,
      holderEmail,
      deps,
      db,
      fenced,
    );
  } catch (error) {
    const blocked = releaseBlockCode(error);
    if (blocked) return { outcome: 'release_blocked', releaseBlocked: blocked };
    if (error instanceof AppError && error.code === 'TEMPLATE_CONTENT_CHANGED') throw error;
    // A static credential cannot rotate for a new holder: the admin sees "needs a new copy", not a fence.
    if (error instanceof ConflictError && error.code === 'PASS_REISSUE_REQUIRED')
      return fail(error);
    if (
      error instanceof ConflictError ||
      (error instanceof AppError && error.code === 'VERSION_CONFLICT')
    ) {
      sctx.log.info('connection.record_fenced', { connectionId: conn.id, code: error.code });
      // Losing the version CAS on an existing pass wrote nothing.
      return {
        outcome: error.code === 'PASS_CONFLICT' ? 'deferred' : 'fenced',
        ...(snapshot && pass ? { effectFree: true as const } : {}),
      };
    }
    // Only deterministic record problems flag the pass; anything else retries the step or job.
    if (error instanceof PassBuildError || error instanceof AppError) return fail(error);
    throw error;
  }
}

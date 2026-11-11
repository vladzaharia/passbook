import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getDeps } from './deps.ts';
import { validEpochNumbers } from './record-epochs.ts';
import type { Applied, ReleaseBlockCode } from './records.ts';
import type { ConnectionRow } from './repo.ts';
import { markPassSynced, type SyncSnapshot } from './repo-pass-snapshot.ts';
import { type PassReleaseBinding, type SyncPass, validPassReleaseBinding } from './repo-passes.ts';

export function releaseBlockCode(error: unknown): ReleaseBlockCode | null {
  if (!(error instanceof ConflictError)) return null;
  return error.code === 'TEMPLATE_RELEASE_REQUIRED' || error.code === 'TEMPLATE_RELEASE_CONFLICT'
    ? error.code
    : null;
}

type MutationResult = Pick<
  SyncSnapshot,
  | 'identityId'
  | 'credentialGeneration'
  | 'lifecycleGeneration'
  | 'transferPending'
  | 'credentialKeysetCommitment'
> &
  PassReleaseBinding & { pushQueued: boolean };

/** Classify only demonstrable counter drift; malformed or unrelated races remain context-stale. */
export function mutationFence(
  result: MutationResult,
  snapshot: SyncSnapshot,
  pass: SyncPass | null,
  preserveBinding: boolean,
): Applied | null {
  if (
    typeof result.identityId !== 'string' ||
    !result.identityId ||
    !validEpochNumbers(result) ||
    typeof result.transferPending !== 'boolean' ||
    !validPassReleaseBinding(result) ||
    typeof result.pushQueued !== 'boolean' ||
    result.credentialKeysetCommitment !== snapshot.credentialKeysetCommitment
  )
    return { outcome: 'fenced' };
  if (preserveBinding) {
    if (
      result.identityId !== snapshot.identityId ||
      !pass ||
      result.templateId !== pass.templateId ||
      result.templateVersion !== pass.templateVersion ||
      result.releaseId !== pass.releaseId
    )
      return { outcome: 'fenced' };
    if (
      result.credentialGeneration !== snapshot.credentialGeneration ||
      result.lifecycleGeneration !== snapshot.lifecycleGeneration
    ) {
      return { outcome: 'fenced', staleCode: 'STALE_GENERATION' };
    }
  }
  return result.transferPending === false ? null : { outcome: 'fenced' };
}

export function appliedSnapshot(
  outcome: 'unchanged' | 'invalid',
  snapshot: SyncSnapshot,
  pass: SyncPass | null,
): Applied {
  return {
    outcome,
    version: snapshot.expectedVersion,
    status: 'active',
    identityId: snapshot.identityId,
    credentialGeneration: snapshot.credentialGeneration,
    lifecycleGeneration: snapshot.lifecycleGeneration,
    transferPending: snapshot.transferPending,
    pushQueued: false,
    credentialKeysetCommitment: snapshot.credentialKeysetCommitment,
    ...(pass
      ? {
          templateId: pass.templateId,
          templateVersion: pass.templateVersion,
          releaseId: pass.releaseId,
        }
      : {}),
    ownerUserId: snapshot.ownerUserId,
    linkGeneration: snapshot.linkGeneration,
  };
}

export async function markIncomingSynced(
  sctx: ServiceContext,
  snapshot: SyncSnapshot,
  pass: SyncPass | null,
  now: number,
  nextSyncAt: number,
): Promise<Applied> {
  return (await markPassSynced(sctx, { ...snapshot, now, nextSyncAt }))
    ? appliedSnapshot('unchanged', snapshot, pass)
    : { outcome: 'fenced' };
}

/** Missing-policy effects use the same original connection and credential authority. */
export async function markIncomingMissing(
  sctx: ServiceContext,
  conn: ConnectionRow,
  snapshot: SyncSnapshot | null,
  pass: SyncPass | null,
  now: number,
  nextSyncAt: number,
  preserveBinding: boolean,
): Promise<Applied> {
  if (!snapshot) return { outcome: 'unlinked' };
  if (conn.onMissing === 'keep') return markIncomingSynced(sctx, snapshot, pass, now, nextSyncAt);
  try {
    const result = await getDeps().markPassMissing(sctx, snapshot, conn.onMissing);
    const fence = mutationFence(result, snapshot, pass, preserveBinding);
    if (fence) return fence;
    return {
      outcome: 'missing',
      version: result.version,
      status: conn.onMissing === 'void' ? 'voided' : 'active',
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
  } catch (error) {
    const blocked = releaseBlockCode(error);
    if (blocked) return { outcome: 'release_blocked', releaseBlocked: blocked };
    if (error instanceof AppError && error.code === 'TEMPLATE_CONTENT_CHANGED') throw error;
    if (error instanceof ConflictError) {
      sctx.log.info('connection.record_fenced', { connectionId: conn.id, code: error.code });
      return { outcome: 'fenced' };
    }
    throw error;
  }
}

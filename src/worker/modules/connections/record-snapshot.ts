import { validEpochNumbers } from './record-epochs.ts';
import type { ApplyIncomingOptions } from './records.ts';
import type { ConnectionRow } from './repo.ts';
import { type SyncSnapshot, validSyncEpochs } from './repo-pass-snapshot.ts';
import { hasBinding, type SyncPass, validPassReleaseBinding } from './repo-passes.ts';

/** Undefined means stale context; null means unlinked; counter drift is explicitly classified. */
export async function captureRecordSnapshot(
  db: D1Database,
  conn: ConnectionRow,
  ref: string,
  pass: SyncPass | null,
  options: ApplyIncomingOptions,
): Promise<SyncSnapshot | null | undefined | 'STALE_GENERATION'> {
  const binding = options.retainedBinding;
  const reservedPassId = options.retainedReservedPassId;
  const claim = options.retainedClaim;
  const keyset = options.credentialKeysetCommitment;
  if (
    (reservedPassId === undefined) !== (claim === undefined) ||
    (claim !== undefined &&
      (!claim ||
        typeof claim.retentionId !== 'string' ||
        !claim.retentionId ||
        !Number.isSafeInteger(claim.ordinal) ||
        claim.ordinal < 0 ||
        typeof claim.token !== 'string' ||
        !claim.token ||
        !Number.isSafeInteger(claim.revision) ||
        claim.revision < 0 ||
        typeof claim.refHash !== 'string' ||
        !claim.refHash ||
        claim.credentialKeysetCommitment !== keyset))
  )
    return undefined;
  if (
    (binding && reservedPassId !== undefined) ||
    (reservedPassId !== undefined &&
      (typeof reservedPassId !== 'string' ||
        !reservedPassId ||
        pass ||
        (conn.mode !== 'webhook' && conn.mode !== 'hybrid')))
  )
    return undefined;
  if (
    pass &&
    (typeof pass.id !== 'string' ||
      !pass.id ||
      typeof pass.identityId !== 'string' ||
      !pass.identityId ||
      !validEpochNumbers(pass) ||
      typeof pass.transferPending !== 'boolean' ||
      pass.credentialKeysetCommitment !== keyset ||
      !Number.isSafeInteger(pass.version) ||
      pass.version < 1 ||
      !Number.isSafeInteger(pass.linkGeneration) ||
      pass.linkGeneration < 1 ||
      (pass.ownerUserId !== null && typeof pass.ownerUserId !== 'string') ||
      !validPassReleaseBinding(pass) ||
      pass.orgId !== conn.orgId ||
      pass.mode !== 'live' ||
      pass.status !== 'active' ||
      pass.connectionId !== conn.id ||
      pass.externalRef !== ref ||
      pass.deletedAt !== null ||
      pass.removedAt !== null)
  )
    return undefined;
  if (reservedPassId !== undefined && (await hasBinding(db, conn.orgId, conn.id, ref)))
    return undefined;

  const expected = binding?.snapshot;
  if (binding && !expected) return undefined;
  if (expected) {
    if (
      typeof conn.id !== 'string' ||
      !conn.id ||
      typeof conn.orgId !== 'string' ||
      !conn.orgId ||
      typeof ref !== 'string' ||
      !ref ||
      !Number.isSafeInteger(expected.generation) ||
      expected.generation < 1 ||
      expected.expectedConnectionMode !== conn.mode ||
      !pass ||
      typeof expected.identityId !== 'string' ||
      !expected.identityId ||
      !validSyncEpochs(expected) ||
      expected.passId !== pass.id ||
      expected.orgId !== conn.orgId ||
      pass.orgId !== expected.orgId ||
      expected.mode !== 'live' ||
      pass.mode !== expected.mode ||
      expected.status !== 'active' ||
      pass.status !== expected.status ||
      expected.connectionId !== conn.id ||
      pass.connectionId !== expected.connectionId ||
      expected.externalRef !== ref ||
      pass.externalRef !== expected.externalRef ||
      expected.generation !== options.generation ||
      conn.generation !== options.generation ||
      !Number.isSafeInteger(expected.expectedVersion) ||
      expected.expectedVersion < 1 ||
      !Number.isSafeInteger(expected.linkGeneration) ||
      expected.linkGeneration < 1 ||
      (expected.ownerUserId !== null && typeof expected.ownerUserId !== 'string') ||
      expected.identityId !== pass.identityId ||
      expected.credentialKeysetCommitment !== pass.credentialKeysetCommitment
    )
      return undefined;
    if (
      binding?.kind !== 'existing' ||
      binding.credentialKeysetCommitment !== expected.credentialKeysetCommitment ||
      typeof binding.templateId !== 'string' ||
      !binding.templateId ||
      typeof binding.templateVersion !== 'string' ||
      !binding.templateVersion ||
      (binding.releaseId !== null &&
        (typeof binding.releaseId !== 'string' || !binding.releaseId)) ||
      pass.templateId !== binding.templateId ||
      pass.releaseId !== binding.releaseId ||
      pass.templateVersion !== binding.templateVersion
    )
      return undefined;
    if (
      expected.credentialGeneration !== pass.credentialGeneration ||
      expected.lifecycleGeneration !== pass.lifecycleGeneration
    )
      return 'STALE_GENERATION';
    if (
      pass.transferPending !== false ||
      expected.expectedVersion !== pass.version ||
      expected.ownerUserId !== pass.ownerUserId ||
      expected.linkGeneration !== pass.linkGeneration
    )
      return undefined;
    if (!binding) return undefined;
    return {
      ...expected,
      retainedBinding: {
        templateId: binding.templateId,
        releaseId: binding.releaseId,
        templateVersion: binding.templateVersion,
        credentialKeysetCommitment: binding.credentialKeysetCommitment,
      },
    };
  }
  if (!pass) return null;
  if (pass.transferPending !== false) return undefined;
  return {
    passId: pass.id,
    orgId: conn.orgId,
    mode: 'live',
    status: 'active',
    expectedVersion: pass.version,
    expectedRowVersion: pass.rowVersion,
    identityId: pass.identityId,
    credentialGeneration: pass.credentialGeneration,
    lifecycleGeneration: pass.lifecycleGeneration,
    transferPending: pass.transferPending,
    credentialKeysetCommitment: pass.credentialKeysetCommitment,
    ownerUserId: pass.ownerUserId,
    linkGeneration: pass.linkGeneration,
    connectionId: conn.id,
    externalRef: ref,
    generation: options.generation,
    expectedConnectionMode: conn.mode,
  };
}

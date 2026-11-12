import type { ServiceContext } from '../../platform/service-context.ts';
import type { ConnectionReleaseSnapshot, RetainedPassBinding } from './records.ts';
import type { ConnectionRow } from './repo.ts';
import { validSyncEpochs } from './repo-pass-snapshot.ts';
import type { SyncPass } from './repo-passes.ts';
import type { Change } from './sync-apply.ts';
import type { RetainedWebhookCandidate, RetainedWebhookClaim } from './webhook-retention-items.ts';

export type RetainedClaimBinding = Extract<RetainedWebhookCandidate, { kind: 'existing' | 'new' }>;

export interface ObservedClaim {
  token: string;
  revision: number;
  binding: RetainedClaimBinding;
  credentialKeysetCommitment: string;
  reservedPassId?: string;
  retainedClaim?: RetainedWebhookClaim;
}

export interface RetainedItemOptions {
  retainedBinding?: RetainedPassBinding;
  retainedReservedPassId?: string;
  retainedClaim?: RetainedWebhookClaim;
}

/** Capture only the authority used by the claim, never personalization or other secrets. */
export function retainedCandidate(
  sctx: ServiceContext,
  conn: ConnectionRow,
  change: Change,
  pass: SyncPass | null | undefined,
  release: ConnectionReleaseSnapshot,
  credentialKeysetCommitment: string,
): RetainedWebhookCandidate {
  if (!pass) {
    if (change.deleted || !conn.autoCreate || !conn.defaultTemplateId) return { kind: 'no-effect' };
    return {
      kind: 'new',
      reservedPassId: sctx.ids.id(),
      orgId: conn.orgId,
      connectionId: conn.id,
      externalRef: change.ref,
      generation: conn.generation,
      templateId: conn.defaultTemplateId,
      expectedRelease: release,
      credentialKeysetCommitment,
    };
  }
  const passId = typeof pass.id === 'string' ? pass.id : '';
  // The claim layer looks up malformed captures by ref and parks the raw binding.
  if (
    !passId ||
    pass.credentialKeysetCommitment !== credentialKeysetCommitment ||
    typeof pass.identityId !== 'string' ||
    !pass.identityId ||
    pass.orgId !== conn.orgId ||
    pass.mode !== 'live' ||
    pass.status !== 'active' ||
    pass.connectionId !== conn.id ||
    pass.externalRef !== change.ref ||
    pass.deletedAt !== null ||
    pass.removedAt !== null ||
    !Number.isSafeInteger(pass.version) ||
    pass.version < 1 ||
    !Number.isSafeInteger(pass.linkGeneration) ||
    pass.linkGeneration < 1 ||
    !Number.isSafeInteger(pass.credentialGeneration) ||
    pass.credentialGeneration < 1 ||
    !Number.isSafeInteger(pass.lifecycleGeneration) ||
    pass.lifecycleGeneration < 0 ||
    typeof pass.transferPending !== 'boolean' ||
    (pass.ownerUserId !== null && (typeof pass.ownerUserId !== 'string' || !pass.ownerUserId)) ||
    typeof pass.templateId !== 'string' ||
    !pass.templateId ||
    typeof pass.templateVersion !== 'string' ||
    !pass.templateVersion ||
    (pass.releaseId !== null && (typeof pass.releaseId !== 'string' || !pass.releaseId))
  ) {
    return { kind: 'invalid', passId };
  }
  return {
    kind: 'existing',
    snapshot: {
      passId,
      orgId: pass.orgId,
      mode: pass.mode,
      status: pass.status,
      expectedVersion: pass.version,
      expectedRowVersion: pass.rowVersion,
      identityId: pass.identityId,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      transferPending: pass.transferPending,
      ownerUserId: pass.ownerUserId,
      linkGeneration: pass.linkGeneration,
      connectionId: pass.connectionId,
      externalRef: pass.externalRef,
      generation: conn.generation,
      expectedConnectionMode: conn.mode,
      credentialKeysetCommitment,
    },
    templateId: pass.templateId,
    releaseId: pass.releaseId,
    templateVersion: pass.templateVersion,
    credentialKeysetCommitment,
  };
}

function sameRelease(a: ConnectionReleaseSnapshot, b: ConnectionReleaseSnapshot): boolean {
  if (a === null || b === null) return a === b;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'approved' && b.kind === 'approved') {
    return a.id === b.id && a.generation === b.generation && a.version === b.version;
  }
  return a.kind === 'blocked' && b.kind === 'blocked' && a.code === b.code;
}

/** Compare the returned binding with what this invocation actually submitted. */
function sameBinding(
  candidate: RetainedWebhookCandidate,
  binding: RetainedClaimBinding | undefined,
): boolean {
  if (!binding || typeof binding !== 'object') return false;
  if (candidate.kind === 'new' && binding.kind === 'new') {
    return (
      candidate.reservedPassId === binding.reservedPassId &&
      candidate.orgId === binding.orgId &&
      candidate.connectionId === binding.connectionId &&
      candidate.externalRef === binding.externalRef &&
      candidate.generation === binding.generation &&
      candidate.templateId === binding.templateId &&
      candidate.credentialKeysetCommitment === binding.credentialKeysetCommitment &&
      sameRelease(candidate.expectedRelease, binding.expectedRelease)
    );
  }
  if (candidate.kind !== 'existing' || binding.kind !== 'existing' || !binding.snapshot)
    return false;
  const a = candidate.snapshot;
  const b = binding.snapshot;
  return (
    a.passId === b.passId &&
    a.orgId === b.orgId &&
    a.mode === b.mode &&
    a.status === b.status &&
    a.expectedVersion === b.expectedVersion &&
    a.identityId === b.identityId &&
    a.credentialGeneration === b.credentialGeneration &&
    a.lifecycleGeneration === b.lifecycleGeneration &&
    a.transferPending === b.transferPending &&
    a.ownerUserId === b.ownerUserId &&
    a.linkGeneration === b.linkGeneration &&
    a.connectionId === b.connectionId &&
    a.externalRef === b.externalRef &&
    a.generation === b.generation &&
    a.expectedConnectionMode === b.expectedConnectionMode &&
    a.credentialKeysetCommitment === b.credentialKeysetCommitment &&
    candidate.credentialKeysetCommitment === binding.credentialKeysetCommitment &&
    candidate.credentialKeysetCommitment === a.credentialKeysetCommitment &&
    b.retainedBinding === undefined &&
    candidate.templateId === binding.templateId &&
    candidate.releaseId === binding.releaseId &&
    candidate.templateVersion === binding.templateVersion
  );
}

/** A token is usable only with the exact committed binding and, for creation, its durable proof. */
export function retainedOptions(
  _conn: ConnectionRow,
  _change: Change,
  _pass: SyncPass | null | undefined,
  candidate: RetainedWebhookCandidate,
  claim: ObservedClaim,
  index: number,
): RetainedItemOptions | null {
  if (
    !Number.isSafeInteger(claim.revision) ||
    claim.revision < 0 ||
    typeof claim.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(claim.credentialKeysetCommitment) ||
    !sameBinding(candidate, claim.binding)
  )
    return null;
  if (candidate.kind === 'existing' && claim.binding.kind === 'existing') {
    if (
      claim.reservedPassId !== undefined ||
      claim.retainedClaim !== undefined ||
      !validSyncEpochs(claim.binding.snapshot) ||
      candidate.credentialKeysetCommitment !== claim.credentialKeysetCommitment ||
      candidate.snapshot.credentialKeysetCommitment !== claim.credentialKeysetCommitment
    )
      return null;
    return {
      retainedBinding: {
        ...claim.binding,
        credentialKeysetCommitment: claim.credentialKeysetCommitment,
      },
    };
  }
  if (candidate.kind === 'new' && claim.binding.kind === 'new') {
    const proof = claim.retainedClaim;
    if (
      claim.reservedPassId !== candidate.reservedPassId ||
      candidate.credentialKeysetCommitment !== claim.credentialKeysetCommitment ||
      typeof claim.reservedPassId !== 'string' ||
      !claim.reservedPassId ||
      !proof ||
      typeof proof.retentionId !== 'string' ||
      !proof.retentionId ||
      proof.ordinal !== index ||
      proof.token !== claim.token ||
      proof.revision !== claim.revision ||
      proof.credentialKeysetCommitment !== claim.credentialKeysetCommitment ||
      typeof proof.refHash !== 'string' ||
      !proof.refHash
    )
      return null;
    return { retainedReservedPassId: claim.reservedPassId, retainedClaim: proof };
  }
  return null;
}

import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getWalletProviderReadiness } from './account-service.ts';
import { queueWalletOperation } from './instance.ts';
import type { WalletInstance, WalletOperationKind, WalletQueueProof } from './instance-types.ts';
import { boundaryPhase, walletBoundaries } from './lifecycle-boundary.ts';
import { projectionPolicy } from './projection-contract.ts';
import { getApprovedProjection } from './projection-service.ts';
import { getInstanceById, readAccountEpoch, type WalletPassSnapshot } from './repo-instance.ts';
import { getProjectionRetirementMetadata } from './repo-projection.ts';
import { samsungSyncCountryHints } from './repo-sync-targets.ts';

export type ScheduleResult = 'scheduled' | 'blocked' | 'unchanged';

/** Re-read and bind every dimension; no caller-supplied projection or account is trusted. */
export async function scheduleInstance(
  ctx: ServiceContext,
  instance: WalletInstance,
  pass: WalletPassSnapshot,
  kind: WalletOperationKind,
  reissueId?: string,
): Promise<ScheduleResult> {
  if (instance.lifecycle === 'retired') return kind === 'revoke' ? 'unchanged' : 'blocked';
  if (instance.lifecycle === 'blocked' || instance.lifecycle === 'ready') return 'blocked';
  const scope = { orgId: instance.orgId, mode: instance.mode, provider: instance.provider };
  // Read before the account state so a rotation of the identity in between refuses at the grant.
  if (instance.accountId === null) return 'blocked';
  const accountEpoch = await readAccountEpoch(ctx.env.DB, instance.accountId);
  if (accountEpoch === null) return 'blocked';
  const account = await getWalletProviderReadiness(ctx, scope);
  if (account.accountId !== instance.accountId || account.state !== 'configured') return 'blocked';
  if (instance.identityProjectionReleaseId === null) return 'blocked';
  const original = await getProjectionRetirementMetadata(
    ctx.env.DB,
    instance.identityProjectionReleaseId,
  );
  if (
    !original ||
    original.id !== instance.identityProjectionReleaseId ||
    original.accountId !== instance.accountId ||
    original.orgId !== instance.orgId ||
    original.mode !== instance.mode ||
    original.provider !== instance.provider ||
    original.templateId !== pass.templateId
  )
    return 'blocked';

  let projectionReleaseId = original.id;
  let adapterRevision = original.adapterRevision;
  let policyRevision = original.policyRevision;
  if (kind === 'upsert') {
    if (
      instance.credentialGeneration !== pass.credentialGeneration ||
      pass.status !== 'active' ||
      pass.removedAt !== null ||
      pass.deletedAt !== null ||
      pass.quarantined !== 0 ||
      !pass.issuingReleaseId
    )
      return 'blocked';
    const approved = await getApprovedProjection(ctx, {
      ...scope,
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      appleReleaseId: pass.issuingReleaseId,
    });
    if (
      !approved ||
      approved.release.accountId !== instance.accountId ||
      // D2: a same-identity rotation moves the revision, not the epoch; the identity hash is compared below.
      approved.release.accountEpoch !== accountEpoch ||
      approved.release.providerIdentityHash !== original.providerIdentityHash ||
      approved.projection.provider !== instance.provider
    )
      return 'blocked';
    projectionReleaseId = approved.release.id;
    const policy = projectionPolicy(instance.provider);
    adapterRevision = policy.adapterRevision;
    policyRevision = policy.audiencePolicyRevision;
  }
  const proof: WalletQueueProof = {
    ...scope,
    passId: pass.passId,
    passVersion: pass.passVersion,
    passRevision: pass.passRevision,
    passRowVersion: pass.passRowVersion,
    accountEpoch,
    lifecycleGeneration: pass.lifecycleGeneration,
    passCredentialGeneration: pass.credentialGeneration,
    issuingReleaseId: pass.issuingReleaseId,
    projectionReleaseId,
    accountId: instance.accountId,
    accountRevision: account.revision,
    adapterRevision,
    policyRevision,
  };
  // Stable idempotency for duplicate mutation hooks and dirty-trigger replay. No holder data or
  // bearer capability is part of this key; the instance repository stores its hash only.
  const countryHints =
    instance.provider === 'samsung'
      ? await samsungSyncCountryHints(ctx, {
          instanceId: instance.id,
          orgId: instance.orgId,
          mode: instance.mode,
        })
      : [];
  const now = ctx.clock.now();
  const boundaries = kind === 'upsert' ? await walletBoundaries(ctx, pass.passId) : [];
  const requestKey = await sha256Hex(
    JSON.stringify([
      'wallet-lifecycle-v1',
      instance.id,
      kind,
      proof.passVersion,
      proof.passRevision,
      proof.lifecycleGeneration,
      proof.passCredentialGeneration,
      instance.credentialGeneration,
      proof.issuingReleaseId,
      proof.projectionReleaseId,
      proof.accountId,
      proof.accountRevision,
      proof.adapterRevision,
      proof.policyRevision,
      countryHints,
      boundaryPhase(boundaries, now),
      kind === 'upsert' ? (reissueId ?? null) : null,
    ]),
  );
  const op = await queueWalletOperation(ctx, {
    ...proof,
    instanceId: instance.id,
    expectedVersion: instance.desiredVersion,
    kind,
    requestKey,
    now: ctx.clock.now(),
    newId: () => ctx.ids.id(),
  });
  if (!op || op.state === 'superseded') return 'blocked';
  const current = await getInstanceById(ctx.env.DB, { ...scope, instanceId: instance.id });
  return current?.desiredOperationId === op.id && current.desiredVersion === op.version
    ? 'scheduled'
    : 'blocked';
}

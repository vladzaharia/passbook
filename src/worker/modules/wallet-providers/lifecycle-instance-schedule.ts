import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getWalletProviderReadiness } from './account-service.ts';
import { queueWalletOperation } from './instance.ts';
import type { WalletInstance, WalletInstanceProof, WalletOperationKind } from './instance-types.ts';
import { projectionPolicy } from './projection-contract.ts';
import { getApprovedProjection } from './projection-service.ts';
import { getInstanceById, type WalletPassSnapshot } from './repo-instance.ts';
import { getProjectionRetirementMetadata } from './repo-projection.ts';
import { samsungSyncCountryHints } from './repo-sync-targets.ts';

export type ScheduleResult = 'scheduled' | 'blocked' | 'unchanged';

/** Re-read and bind every dimension; no caller-supplied projection or account is trusted. */
export async function scheduleInstance(
  ctx: ServiceContext,
  instance: WalletInstance,
  pass: WalletPassSnapshot,
  kind: WalletOperationKind,
): Promise<ScheduleResult> {
  if (instance.lifecycle === 'retired') return kind === 'revoke' ? 'unchanged' : 'blocked';
  if (instance.lifecycle === 'blocked' || instance.lifecycle === 'ready') return 'blocked';
  const scope = { orgId: instance.orgId, mode: instance.mode, provider: instance.provider };
  const account = await getWalletProviderReadiness(ctx, scope);
  if (account.accountId !== instance.accountId || account.state !== 'configured') return 'blocked';
  if (instance.identityProjectionReleaseId === null) return 'blocked';
  const original = await getProjectionRetirementMetadata(
    ctx.env.DB,
    instance.identityProjectionReleaseId,
    { credentialKeysetCommitment: pass.credentialKeysetCommitment },
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
    const approved = await getApprovedProjection(
      ctx,
      {
        ...scope,
        templateId: pass.templateId,
        templateVersion: pass.templateVersion,
        appleReleaseId: pass.issuingReleaseId,
      },
      { credentialKeysetCommitment: pass.credentialKeysetCommitment },
    );
    if (
      !approved ||
      approved.release.accountId !== instance.accountId ||
      approved.release.accountRevision !== account.revision ||
      approved.release.providerIdentityHash !== original.providerIdentityHash ||
      approved.projection.provider !== instance.provider
    )
      return 'blocked';
    projectionReleaseId = approved.release.id;
    const policy = projectionPolicy(instance.provider);
    adapterRevision = policy.adapterRevision;
    policyRevision = policy.audiencePolicyRevision;
  }
  const proof: WalletInstanceProof = {
    ...scope,
    passId: pass.passId,
    passVersion: pass.passVersion,
    passRevision: pass.passRevision,
    lifecycleGeneration: pass.lifecycleGeneration,
    passCredentialGeneration: pass.credentialGeneration,
    issuingReleaseId: pass.issuingReleaseId,
    credentialKeysetCommitment: pass.credentialKeysetCommitment,
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
          credentialKeysetCommitment: pass.credentialKeysetCommitment,
        })
      : [];
  if ((await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== pass.credentialKeysetCommitment)
    return 'blocked';
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
      proof.credentialKeysetCommitment,
      countryHints,
    ]),
  );
  const op = await queueWalletOperation(ctx.env.DB, {
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

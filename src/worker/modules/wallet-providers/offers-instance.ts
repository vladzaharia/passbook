import type { ServiceContext } from '../../platform/service-context.ts';
import type { WalletInstance } from './instance.ts';
import type { EligibleWalletProvider } from './offers-eligibility.ts';
import { getProjectionRetirementMetadata } from './repo-projection.ts';

/** An existing provider object retains its original class/account identity across revisions. */
export async function instanceMatches(
  ctx: ServiceContext,
  eligible: EligibleWalletProvider,
  instance: WalletInstance,
  allowRestore = false,
): Promise<boolean> {
  const { pass } = eligible.snapshot;
  if (
    instance.passId !== pass.id ||
    instance.orgId !== pass.orgId ||
    instance.mode !== pass.mode ||
    instance.credentialGeneration !== eligible.snapshot.credentialGeneration ||
    instance.credentialKeysetCommitment !== eligible.snapshot.credentialKeysetCommitment ||
    instance.provider !== eligible.approved.projection.provider ||
    instance.retirementRequestedAt !== null
  )
    return false;
  // A committed target has no provider identity until its first atomic issuance.
  if (instance.lifecycle === 'ready') return allowRestore && instance.desiredVersion === 0;
  if (
    instance.lifecycle === 'blocked' ||
    instance.lifecycle === 'retired' ||
    (!allowRestore && instance.lifecycle !== 'active') ||
    instance.accountId !== eligible.runtimeScope.accountId
  )
    return false;
  const originReleaseId = instance.identityProjectionReleaseId;
  if (!originReleaseId) return false;
  const origin = await getProjectionRetirementMetadata(ctx.env.DB, originReleaseId, {
    credentialKeysetCommitment: eligible.snapshot.credentialKeysetCommitment,
  });
  return (
    !!origin &&
    origin.orgId === pass.orgId &&
    origin.mode === pass.mode &&
    origin.provider === instance.provider &&
    origin.templateId === pass.templateId &&
    origin.accountId === instance.accountId &&
    origin.providerIdentityHash === eligible.runtimeScope.providerIdentityHash
  );
}

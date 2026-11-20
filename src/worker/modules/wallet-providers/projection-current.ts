import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import type { NativeProvider } from './projection-contract.ts';
import { getApprovedProjection } from './projection-service.ts';
import { getProjectionRetirementMetadata } from './repo-projection.ts';

export interface ProjectionApprovalBinding {
  orgId: string;
  mode: Mode;
  provider: NativeProvider;
  accountId: string;
  accountRevision: number;
  providerIdentityHash: string;
  releaseId: string;
}

/** Checks provider card state and release, not recipient-market or device eligibility. */
export async function isCurrentApprovedProjection(
  ctx: ServiceContext,
  binding: ProjectionApprovalBinding,
): Promise<boolean> {
  ctx = snapshotWalletCredentialContext(ctx);
  Object.freeze(ctx.env);
  binding = { ...binding };
  const metadata = await getProjectionRetirementMetadata(ctx.env.DB, binding.releaseId);
  if (
    !metadata ||
    metadata.orgId !== binding.orgId ||
    metadata.mode !== binding.mode ||
    metadata.provider !== binding.provider ||
    metadata.accountId !== binding.accountId ||
    metadata.accountRevision !== binding.accountRevision ||
    metadata.providerIdentityHash !== binding.providerIdentityHash
  )
    return false;
  const approved = await getApprovedProjection(ctx, {
    orgId: binding.orgId,
    mode: binding.mode,
    provider: binding.provider,
    templateId: metadata.templateId,
    templateVersion: metadata.version,
    appleReleaseId: metadata.sourceReleaseId,
    adapterRevision: metadata.adapterRevision,
    audiencePolicyRevision: metadata.policyRevision,
  });
  return approved?.release.id === binding.releaseId;
}

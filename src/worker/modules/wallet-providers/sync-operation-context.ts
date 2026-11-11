import type { ServiceContext } from '../../platform/service-context.ts';
import type { WalletClaimRef, WalletOperation } from './instance-types.ts';
import {
  getProjectionRetirementMetadata,
  type ProjectionRetirementMetadata,
} from './repo-projection.ts';
import type { WalletRuntimeScope } from './runtime.ts';
import type { WalletRuntimeResponseSink } from './runtime-response.ts';

export type WalletSyncRunResult = 'completed' | 'deferred' | 'not_claimed' | 'uncertain';

export interface WalletSyncOperationBinding {
  scope: WalletRuntimeScope;
  original: ProjectionRetirementMetadata;
}

/** Mutable state is shared with provider response and currentness callbacks. */
export interface WalletSyncOperationExecution {
  ctx: ServiceContext;
  claim: WalletClaimRef;
  op: WalletOperation;
  fenceLost: boolean;
  lastResponseStatus: number | null;
  holdClaim: () => Promise<WalletSyncRunResult>;
  assertCurrent: () => Promise<void>;
  onProviderResponse: WalletRuntimeResponseSink;
}

/** An operation and its original provider identity must remain in the same tenant and account. */
export async function originalScope(
  ctx: ServiceContext,
  op: WalletOperation,
): Promise<WalletSyncOperationBinding | null> {
  const original = await getProjectionRetirementMetadata(
    ctx.env.DB,
    op.identityProjectionReleaseId,
    { credentialKeysetCommitment: op.credentialKeysetCommitment },
  );
  if (
    !original ||
    original.id !== op.identityProjectionReleaseId ||
    original.orgId !== op.orgId ||
    original.mode !== op.mode ||
    original.provider !== op.provider ||
    original.accountId !== op.accountId
  )
    return null;
  return {
    original,
    scope: {
      orgId: op.orgId,
      mode: op.mode,
      accountId: op.accountId,
      accountRevision: op.accountRevision,
      providerIdentityHash: original.providerIdentityHash,
      providerReleaseId: op.projectionReleaseId,
      credentialKeysetCommitment: op.credentialKeysetCommitment,
    },
  };
}

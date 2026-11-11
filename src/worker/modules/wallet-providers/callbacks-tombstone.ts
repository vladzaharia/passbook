import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { pinSamsungCredentialContext, requireSamsungCredentialKeyset } from './callbacks-ref.ts';
import { getWalletOperation } from './instance.ts';
import {
  claimSamsungTombstoneReplay,
  findSamsungTombstones,
  putSamsungTombstone,
  type SamsungRetirementScope,
  samsungTombstoneStillDeleted,
} from './repo-callbacks-tombstone.ts';
import { getProjectionRetirementMetadata } from './repo-projection.ts';
import { verifySamsungTombstoneRuntimeRequest, WalletRuntimeError } from './runtime.ts';
import { SamsungReplayStoreError, SamsungTokenError } from './samsung.ts';

const MAX_HISTORICAL_VERIFIERS = 32;

/** Persist before retiring/deleting the pass, after the provider accepted its revoke. */
export async function persistSamsungTombstone(
  ctx: ServiceContext,
  scope: SamsungRetirementScope,
): Promise<boolean> {
  ctx = pinSamsungCredentialContext(ctx);
  scope = { ...scope };
  await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
  const op = await getWalletOperation(ctx.env.DB, {
    orgId: scope.orgId,
    mode: scope.mode,
    provider: 'samsung',
    instanceId: scope.instanceId,
    version: scope.operationVersion,
    credentialKeysetCommitment: scope.credentialKeysetCommitment,
  });
  if (
    op?.kind !== 'revoke' ||
    op.state !== 'succeeded' ||
    op.credentialKeysetCommitment !== scope.credentialKeysetCommitment
  )
    return false;
  const original = await getProjectionRetirementMetadata(
    ctx.env.DB,
    op.identityProjectionReleaseId,
    { credentialKeysetCommitment: scope.credentialKeysetCommitment },
  );
  if (
    original?.provider !== 'samsung' ||
    original.orgId !== scope.orgId ||
    original.mode !== scope.mode ||
    original.accountId !== op.accountId ||
    original.id !== op.projectionReleaseId
  )
    return false;
  const stored = await putSamsungTombstone(
    ctx.env.DB,
    scope,
    original.providerIdentityHash,
    ctx.clock.now(),
  );
  await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
  return stored;
}

/** Authenticate against pinned approved historical certificates, without opening any card data. */
export async function authenticateSamsungTombstone(
  ctx: ServiceContext,
  request: Request,
  refId: string,
  refHash: string,
  credentialKeysetCommitment: string,
): Promise<boolean> {
  ctx = pinSamsungCredentialContext(ctx);
  await requireSamsungCredentialKeyset(ctx, credentialKeysetCommitment);
  const scopes = await findSamsungTombstones(ctx.env.DB, refHash, credentialKeysetCommitment);
  if (scopes.length > MAX_HISTORICAL_VERIFIERS)
    throw new UnavailableError('Samsung Wallet service is unavailable.', 'SAMSUNG_UNAVAILABLE');
  for (const scope of scopes) {
    try {
      await verifySamsungTombstoneRuntimeRequest(ctx, scope, {
        request,
        refId,
        claimReplay: (tokenHash, expiresAt) =>
          claimSamsungTombstoneReplay(ctx.env.DB, scope, {
            tokenHash,
            expiresAt,
            claimId: ctx.ids.id(),
            now: ctx.clock.now(),
          }),
      });
      await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
      const deleted = await samsungTombstoneStillDeleted(ctx.env.DB, scope);
      await requireSamsungCredentialKeyset(ctx, scope.credentialKeysetCommitment);
      return deleted;
    } catch (error) {
      if (error instanceof SamsungTokenError) continue;
      if (error instanceof SamsungReplayStoreError || error instanceof WalletRuntimeError)
        throw new UnavailableError('Samsung Wallet service is unavailable.', 'SAMSUNG_UNAVAILABLE');
      throw error;
    }
  }
  return false;
}

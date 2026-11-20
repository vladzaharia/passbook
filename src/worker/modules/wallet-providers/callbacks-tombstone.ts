import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { pinSamsungCredentialContext } from './callbacks-ref.ts';
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
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const op = await getWalletOperation(ctx.env.DB, {
    orgId: scope.orgId,
    mode: scope.mode,
    provider: 'samsung',
    instanceId: scope.instanceId,
    version: scope.operationVersion,
  });
  if (op?.kind !== 'revoke' || op.state !== 'succeeded') return false;
  const original = await getProjectionRetirementMetadata(
    ctx.env.DB,
    op.identityProjectionReleaseId,
  );
  if (
    original?.provider !== 'samsung' ||
    original.orgId !== scope.orgId ||
    original.mode !== scope.mode ||
    original.accountId !== op.accountId ||
    original.id !== op.projectionReleaseId
  )
    return false;
  return putSamsungTombstone(ctx.env.DB, scope, original.providerIdentityHash, ctx.clock.now());
}

/** Authenticate against pinned approved historical certificates, without opening any card data. */
export async function authenticateSamsungTombstone(
  ctx: ServiceContext,
  request: Request,
  refId: string,
  refHash: string,
): Promise<boolean> {
  ctx = pinSamsungCredentialContext(ctx);
  const scopes = await findSamsungTombstones(ctx.env.DB, refHash);
  if (scopes.length > MAX_HISTORICAL_VERIFIERS)
    throw new UnavailableError('Samsung Wallet service is unavailable.', 'SAMSUNG_UNAVAILABLE');
  for (const scope of scopes) {
    try {
      await verifySamsungTombstoneRuntimeRequest(ctx, scope, {
        request,
        refId,
        method: request.method === 'POST' ? 'POST' : 'GET',
        claimReplay: (tokenHash, expiresAt) =>
          claimSamsungTombstoneReplay(ctx.env.DB, scope, {
            tokenHash,
            expiresAt,
            claimId: ctx.ids.id(),
            now: ctx.clock.now(),
          }),
      });
      return await samsungTombstoneStillDeleted(ctx.env.DB, scope);
    } catch (error) {
      if (error instanceof SamsungTokenError) continue;
      if (error instanceof SamsungReplayStoreError || error instanceof WalletRuntimeError)
        throw new UnavailableError('Samsung Wallet service is unavailable.', 'SAMSUNG_UNAVAILABLE');
      throw error;
    }
  }
  return false;
}

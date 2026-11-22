import type { ServiceContext } from '../../platform/service-context.ts';
import { assertNotPreviewOnly } from '../developer/fence.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import { isCurrentApprovedProjection } from './projection-current.ts';
import { assertWalletProviderEnabled } from './provider-policy.ts';
import {
  copyRuntimeScope,
  runtimeAccountUnavailable,
  type WalletRuntimeScope,
} from './runtime-core-credentials.ts';

/**
 * Whether Google may issue for this scope right now: the platform release, a non-developer org and the
 * current approved release. No credential is opened; an operation that needs one reads it under
 * `issuance`, so listing offers never decrypts the account.
 */
export async function runtimeGoogleIssuanceCurrent(
  ctx: ServiceContext,
  inputScope: WalletRuntimeScope,
): Promise<void> {
  ctx = snapshotWalletCredentialContext(ctx);
  const scope = copyRuntimeScope(inputScope);
  assertWalletProviderEnabled('google', scope.mode);
  await assertNotPreviewOnly(ctx.env.DB, scope.orgId);
  const current = await isCurrentApprovedProjection(ctx, {
    orgId: scope.orgId,
    mode: scope.mode,
    provider: 'google',
    accountId: scope.accountId,
    accountRevision: scope.accountRevision,
    accountEpoch: scope.accountEpoch,
    providerIdentityHash: scope.providerIdentityHash,
    releaseId: scope.providerReleaseId,
  });
  if (!current) throw runtimeAccountUnavailable();
}

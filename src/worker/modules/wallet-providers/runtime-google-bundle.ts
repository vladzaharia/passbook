import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import { combineGoogleSaveOffers, type GoogleSaveOffer } from './google-offer.ts';
import type { WalletRuntimeScope } from './runtime-core.ts';
import { copyRuntimeScope, runtimeExecution, runtimeGoogleAccount } from './runtime-core.ts';

/** Signs one save link over the objects of links this scope just issued; see `combineGoogleSaveOffers`. */
export async function combineGoogleRuntimeOffers(
  ctx: ServiceContext,
  inputScope: WalletRuntimeScope,
  urls: readonly string[],
  assertCurrent?: () => Promise<void>,
): Promise<GoogleSaveOffer> {
  ctx = snapshotWalletCredentialContext(ctx);
  const scope = copyRuntimeScope(inputScope);
  const purpose = { kind: 'issuance' } as const;
  const { account } = await runtimeGoogleAccount(ctx, scope, purpose);
  const call = runtimeExecution(ctx, scope, 'google', assertCurrent, undefined, purpose);
  return call.finish(async () => {
    if (assertCurrent) await assertCurrent();
    return combineGoogleSaveOffers(account, urls, Math.floor(ctx.clock.now() / 1000));
  });
}

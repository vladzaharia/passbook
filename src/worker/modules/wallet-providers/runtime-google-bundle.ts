import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import { combineGoogleSaveRefs, type GoogleSaveOffer } from './google-offer.ts';
import {
  copyRuntimeScope,
  runtimeExecution,
  runtimeGoogleAccount,
  type WalletRuntimeScope,
} from './runtime-core.ts';

/** Signs one save link over objects this scope just issued; see `combineGoogleSaveRefs`. */
export async function combineGoogleRuntimeOffers(
  ctx: ServiceContext,
  inputScope: WalletRuntimeScope,
  offers: readonly Pick<GoogleSaveOffer, 'objectId' | 'type' | 'expiresAt'>[],
  assertCurrent?: () => Promise<void>,
): Promise<string> {
  ctx = snapshotWalletCredentialContext(ctx);
  const scope = copyRuntimeScope(inputScope);
  const purpose = { kind: 'issuance' } as const;
  const { account } = await runtimeGoogleAccount(ctx, scope, purpose);
  const call = runtimeExecution(ctx, scope, 'google', assertCurrent, undefined, purpose);
  return call.finish(async () => {
    if (assertCurrent) await assertCurrent();
    return combineGoogleSaveRefs(account, offers, {
      origins: [new URL(baseUrl(ctx.env)).origin],
      issuedAt: Math.floor(ctx.clock.now() / 1000),
    });
  });
}

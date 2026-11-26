import { credentialAad, type Envelope, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { SamsungCallbackInput, SamsungCallbackResult } from './callbacks-samsung-types.ts';
import { walletProviderEnabled } from './provider-policy.ts';
import {
  claimSamsungIssuedDelivery,
  findSamsungIssuedRefs,
  samsungTokenRecorded,
} from './repo-callbacks-state.ts';
import { verifySamsungTombstoneRuntimeRequest, WalletRuntimeError } from './runtime.ts';
import { SamsungReplayStoreError, SamsungTokenError } from './samsung.ts';

/**
 * An authentic request for an issued ref that its live fences no longer cover: an unpromoted ref
 * after its window, a revoke before its tombstone, a pending transfer, a failed operation or a
 * voided pass. The token is verified against the credential the instance operated under; the
 * answer carries no card data (200 for Send Card State, 204 for Get Card Data). Only a Send Card
 * State leaves a receipt, and an ADDED promotes a ref that served card data. Null: not ours.
 */
export async function answerSamsungIssuedRef(
  ctx: ServiceContext,
  input: SamsungCallbackInput,
): Promise<SamsungCallbackResult | null> {
  const { request, refId, refHash, method, countryHint, event, requestId, body } = input;
  const refs = await findSamsungIssuedRefs(ctx.env.DB, refHash);
  // Nothing is sealed until a token has verified: crypto work before authentication is free for an attacker.
  const receiptId = method === 'POST' ? ctx.ids.id() : null;
  let sealed: Envelope | null = null;
  for (const ref of refs) {
    const delivery = { duplicate: false };
    try {
      await verifySamsungTombstoneRuntimeRequest(ctx, ref, {
        request,
        refId,
        method,
        source: 'issued',
        claimReplay: async (tokenHash, expiresAt, signedAt, queryBound, writable) => {
          if (await samsungTokenRecorded(ctx.env.DB, tokenHash, ref.referenceId)) {
            delivery.duplicate = true;
            return true;
          }
          const claim = { tokenHash, expiresAt, claimId: ctx.ids.id(), now: ctx.clock.now() };
          // An older or revoked credential may authenticate the callback, so it is answered and
          // its token spent, but it records nothing and changes nothing. While draining an ADDED
          // promotes nothing either; any other state (a holder's DELETED) is recorded.
          const promoting = event === 'ADDED' && !walletProviderEnabled('samsung', ref.mode);
          if (method === 'GET' || !writable || promoting || !receiptId || !body)
            return claimSamsungIssuedDelivery(ctx.env.DB, ref, claim, null);
          sealed ??= await encryptSecret(
            await loadKekRing(ctx.env),
            body,
            credentialAad(receiptId, ref.orgId, `samsung-callback|${ref.mode}|${ref.instanceId}`),
          );
          const receipt = {
            id: receiptId,
            signedAt,
            envelope: sealed,
            countryHint,
            event,
            requestId,
            queryBound,
          };
          return claimSamsungIssuedDelivery(ctx.env.DB, ref, claim, receipt);
        },
      });
    } catch (error) {
      if (error instanceof SamsungTokenError) continue;
      if (error instanceof SamsungReplayStoreError || error instanceof WalletRuntimeError)
        throw new UnavailableError('Samsung Wallet service is unavailable.', 'SAMSUNG_UNAVAILABLE');
      throw error;
    }
    ctx.log.info('wallet.callback_state', {
      code: delivery.duplicate ? 'WALLET_CALLBACK_DUPLICATE' : 'WALLET_CALLBACK_ISSUED',
      provider: 'samsung',
      orgId: ref.orgId,
      event: event ?? 'unknown',
    });
    if (method === 'POST' && event === 'ADDED' && !countryHint)
      ctx.log.warn('wallet.callback_state', {
        code: 'WALLET_SAMSUNG_NO_MARKET',
        provider: 'samsung',
        orgId: ref.orgId,
      });
    return method === 'GET' ? { kind: 'missing' } : { kind: 'accepted' };
  }
  return null;
}

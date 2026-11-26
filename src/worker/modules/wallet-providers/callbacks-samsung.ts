import { BadRequestError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { readSamsungCallbackBody } from './callbacks-body.ts';
import {
  samsungCardEvent,
  samsungCountryHint,
  samsungRequestedFields,
} from './callbacks-fields.ts';
import { pinSamsungCredentialContext } from './callbacks-ref.ts';
import { answerSamsungIssuedRef } from './callbacks-samsung-issued.ts';
import { serveSamsungLive } from './callbacks-samsung-live.ts';
import {
  type SamsungCallbackInput,
  type SamsungCallbackResult,
  unauthenticated,
} from './callbacks-samsung-types.ts';
import { authenticateSamsungTombstone } from './callbacks-tombstone.ts';
import {
  walletProviderEnabled,
  walletProviderReleaseReason,
  walletProviderRevokes,
} from './provider-policy.ts';
import { findSamsungFetchSnapshot } from './repo-callbacks.ts';

/** Only the exact configured partner endpoint is admitted, with no path normalization aliases. */
export async function handleSamsungCallback(
  ctx: ServiceContext,
  request: Request,
): Promise<SamsungCallbackResult> {
  ctx = pinSamsungCredentialContext(ctx);
  const url = new URL(request.url);
  const match = /^\/wallet\/v1\/samsung\/cards\/([A-Za-z0-9_-]{1,32})\/([A-Za-z0-9_-]{32})$/.exec(
    url.pathname,
  );
  if (!match || (request.method !== 'GET' && request.method !== 'POST'))
    throw new BadRequestError();
  const refId = match[2];
  if (!refId) throw new BadRequestError();
  const method = request.method;
  // Dark everywhere: credentials cannot be opened, so nothing can be verified or promoted; the answer is constant,
  // carries no state and records nothing. Draining still answers the cards it has (below).
  if (!walletProviderRevokes('samsung')) {
    ctx.log.info('wallet.callback_ignored', {
      code: 'WALLET_PROVIDER_DISABLED',
      provider: 'samsung',
      reason: walletProviderReleaseReason('samsung'),
    });
    return method === 'GET' ? { kind: 'missing' } : { kind: 'accepted' };
  }
  const fields = method === 'GET' ? samsungRequestedFields(url) : null;
  const countryHint = method === 'POST' ? samsungCountryHint(url) : null;
  const body = method === 'POST' ? await readSamsungCallbackBody(request) : null;
  const refHash = await sha256Hex(refId);
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const input: SamsungCallbackInput = {
    request,
    refId,
    refHash,
    method,
    fields,
    countryHint,
    event: method === 'POST' ? samsungCardEvent(url) : null,
    body,
    requestId: request.headers.get('x-request-id') ?? '',
  };
  const snapshot = await findSamsungFetchSnapshot(ctx.env.DB, refHash, ctx.clock.now(), false);
  // An authentic request for a ref we do not serve is answered, not rejected: Get Card Data
  // documents 204 for it, Send Card State only 200.
  // Only a released mode serves card data or promotes; while draining a card is answered as an issued ref (no card
  // data, a holder's state recorded, never promoted).
  if (snapshot && walletProviderEnabled('samsung', snapshot.mode)) {
    const live = await serveSamsungLive(ctx, input, snapshot);
    if (live) return live;
  } else if (!snapshot && (await authenticateSamsungTombstone(ctx, request, refId, refHash)))
    return method === 'GET' ? { kind: 'missing' } : { kind: 'accepted' };
  const issued = await answerSamsungIssuedRef(ctx, input);
  if (issued) return issued;
  throw unauthenticated();
}

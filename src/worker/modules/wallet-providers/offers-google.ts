import { runFirstTapUpsert } from '../../jobs/wallet-first-tap.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo-map.ts';
import { registerGoogleCallbackBinding } from './google-callback-binding.ts';
import { googleClassPartition } from './google-compile.ts';
import type { GoogleSaveOffer } from './google-offer.ts';
import { getWalletOperation, type WalletInstance, type WalletOperation } from './instance.ts';
import type { EligibleWalletProvider } from './offers-eligibility.ts';
import { walletOfferNotFound as notFound } from './offers-instance.ts';
import { createGoogleRuntimeOffer } from './runtime.ts';

/** The object's operation failed for good: the answer is the same 503, but a bundle leaves the pass out. */
export class GoogleMemberFailedError extends UnavailableError {}

/** The first tap builds the object itself, inside this budget; a slower provider gets an error page. */
let firstTapBudgetMs = 15_000;

const CLAIM_POLL_MS = 50;

/** Tests only: a budget short enough to outlast with a slow provider. */
export function setFirstTapBudgetForTest(ms: number): () => void {
  const previous = firstTapBudgetMs;
  firstTapBudgetMs = ms;
  return () => {
    firstTapBudgetMs = previous;
  };
}

/** Runs the pending operation inline and returns it as it stands, or null when it did not finish in time. */
async function provisionFirstTap(
  ctx: ServiceContext,
  operation: WalletOperation,
  pass: Pass,
): Promise<{ ready: WalletOperation | null; outcome: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let over = false;
  try {
    const outcome = await Promise.race([
      runFirstTapUpsert(ctx, operation, pass)
        .then(async (result) => {
          // Another runner (the minute cron) holds the claim: wait for its result inside this budget.
          while (result === 'not_claimed' && !over) {
            const row = await getWalletOperation(ctx.env.DB, operation);
            if (row?.state !== 'claimed') break;
            await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
          }
          return result;
        })
        .catch((error: unknown) => {
          ctx.log.warn('wallet.google_first_tap_failed', {
            code: error instanceof AppError ? error.code : 'WALLET_GOOGLE_FIRST_TAP',
          });
          return 'failed' as const;
        }),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), firstTapBudgetMs);
      }),
    ]);
    ctx.log.info('wallet.google_first_tap_ran', { code: 'WALLET_GOOGLE_FIRST_TAP', outcome });
    return {
      ready: outcome === 'timeout' ? null : await getWalletOperation(ctx.env.DB, operation),
      outcome,
    };
  } finally {
    over = true;
    clearTimeout(timer);
  }
}

/**
 * The save link of a pass: its object is provisioned first (the first tap runs the pending upsert itself,
 * never answering 404 for a pass that is merely not on Google yet), then a link that only references it is
 * signed. A save link must never create or overwrite an object from a stale JWT.
 */
export async function googleSaveLocation(
  ctx: ServiceContext,
  p: {
    pass: Pass;
    eligible: EligibleWalletProvider;
    instance: Extract<WalletInstance, { accountId: string }>;
    operation: WalletOperation;
    expiresAt: number;
    assertCurrent: () => Promise<void>;
  },
): Promise<GoogleSaveOffer> {
  const { pass, eligible, instance, expiresAt, assertCurrent } = p;
  let { operation } = p;
  const projection = eligible.approved.projection;
  if (operation.state !== 'succeeded') {
    const { ready, outcome } = await provisionFirstTap(ctx, operation, pass);
    if (ready?.state !== 'succeeded' || ready.id !== operation.id) {
      // A failed operation is final until the pass changes; a bundle leaves such a pass out.
      const failed = ready?.id === operation.id && ready.state === 'failed';
      ctx.log.warn('wallet.google_first_tap_pending', {
        code: failed ? 'WALLET_GOOGLE_FIRST_TAP_FAILED' : 'WALLET_GOOGLE_FIRST_TAP',
        orgId: pass.orgId,
        // Why a first tap ended non-final: the run result, the row it left, and whether a newer row replaced it.
        outcome,
        state: ready?.state ?? 'none',
        superseded: ready !== null && ready.id !== operation.id,
      });
      throw new (failed ? GoogleMemberFailedError : UnavailableError)(
        'Google Wallet is not ready. Try again in a minute.',
        'WALLET_PREPARING',
      );
    }
    operation = ready;
  }
  const partition = await googleClassPartition(ctx, pass, projection);
  await registerGoogleCallbackBinding(ctx, eligible.runtimeScope, {
    instanceId: instance.id,
    passId: pass.id,
    releaseId: instance.identityProjectionReleaseId,
    credentialGeneration: instance.credentialGeneration,
    channelEpoch: instance.channelEpoch,
    operationVersion: operation.version,
    ...(projection.schema === 2 ? { classType: partition.type, classKey: partition.classKey } : {}),
  });
  const lifetimeSeconds = Math.min(900, Math.floor((expiresAt - ctx.clock.now()) / 1000) - 1);
  if (lifetimeSeconds < 1) throw notFound();
  const signed = await createGoogleRuntimeOffer(ctx, eligible.runtimeScope, {
    releaseId: instance.identityProjectionReleaseId,
    passId: pass.id,
    credentialGeneration: instance.credentialGeneration,
    channelEpoch: instance.channelEpoch,
    origins: [new URL(baseUrl(ctx.env)).origin],
    lifetimeSeconds,
    assertCurrent,
    ...(projection.schema === 2 ? partition : {}),
  });
  if (
    !signed.url.startsWith('https://pay.google.com/gp/v/save/') ||
    signed.expiresAt * 1000 > expiresAt ||
    signed.expiresAt * 1000 <= ctx.clock.now()
  )
    throw notFound();
  return signed;
}

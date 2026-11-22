import { walletFirstTapContext } from '../../jobs/wallet-first-tap.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo-map.ts';
import { registerGoogleCallbackBinding } from './google-callback-binding.ts';
import { googleClassPartition } from './google-compile.ts';
import { getWalletOperation, type WalletInstance, type WalletOperation } from './instance.ts';
import type { EligibleWalletProvider } from './offers-eligibility.ts';
import { walletOfferNotFound as notFound } from './offers-instance.ts';
import { createGoogleRuntimeOffer } from './runtime.ts';
import { runWalletProviderOperation } from './sync-operation.ts';

/** The first tap builds the object itself, inside this budget; a slower provider gets an error page. */
const FIRST_TAP_BUDGET_MS = 15_000;

/** Runs the pending operation inline and returns it as it stands, or null when it did not finish in time. */
async function provisionFirstTap(
  ctx: ServiceContext,
  operation: WalletOperation,
): Promise<WalletOperation | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      runWalletProviderOperation(walletFirstTapContext(ctx), operation).catch((error: unknown) => {
        ctx.log.warn('wallet.google_first_tap_failed', {
          code: error instanceof AppError ? error.code : 'WALLET_GOOGLE_FIRST_TAP',
        });
        return 'failed' as const;
      }),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), FIRST_TAP_BUDGET_MS);
      }),
    ]);
    ctx.log.info('wallet.google_first_tap_ran', { code: 'WALLET_GOOGLE_FIRST_TAP', outcome });
    return outcome === 'timeout' ? null : await getWalletOperation(ctx.env.DB, operation);
  } finally {
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
): Promise<string> {
  const { pass, eligible, instance, expiresAt, assertCurrent } = p;
  let { operation } = p;
  const projection = eligible.approved.projection;
  if (operation.state !== 'succeeded') {
    const ready = await provisionFirstTap(ctx, operation);
    if (ready?.state !== 'succeeded' || ready.id !== operation.id) {
      ctx.log.warn('wallet.google_first_tap_pending', {
        code: 'WALLET_GOOGLE_FIRST_TAP',
        orgId: pass.orgId,
      });
      throw new UnavailableError(
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
  return signed.url;
}

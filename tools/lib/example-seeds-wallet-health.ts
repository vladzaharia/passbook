import { T } from './example-world.ts';

/** Wallet health answers whose sampled numbers would contradict each other (waiting above unknown, "ok" with failures). */
export const WALLET_HEALTH_SEEDS: Record<string, unknown> = {
  'wallet-health.getOrgsByOrgIdWalletHealth response': {
    items: [
      {
        provider: 'google',
        mode: 'live',
        tone: 'attention',
        lastSuccessAt: T.now - 120_000,
        queued: 2,
        failed24h: 0,
        uncertain: 4,
        uncertainWaiting: 1,
        callbackAt: T.now - 3_600_000,
      },
    ],
  },
  'wallet-health.postOrgsByOrgIdWalletHealthByProviderRecheck response': { due: 3, waiting: 1 },
};

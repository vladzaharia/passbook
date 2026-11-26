import type { WalletProvider } from '@/shared/contracts/wallet-providers.ts';
import type {
  WalletReleaseBlock,
  WalletReleaseEnrolment,
  WalletReleaseState,
} from '@/shared/contracts/wallet-release.ts';
import { ApiError } from '@/web/lib/errors.ts';
import { PROVIDER_NAME } from './copy.ts';

export const STATE_WORDS: Record<WalletReleaseState, string> = {
  dark: 'Dark',
  draining: 'Draining',
  released: 'Released',
};

export const STATE_TONE = {
  dark: 'neutral',
  draining: 'warning',
  released: 'success',
} as const satisfies Record<WalletReleaseState, string>;

/** What a state means for the owner, in one sentence; null when released. */
export function stateLine(provider: WalletProvider, state: WalletReleaseState): string | null {
  const name = PROVIDER_NAME[provider];
  if (state === 'dark')
    return `${name} isn't released yet. Turning it on is a code change: the flip PR.`;
  if (state === 'draining')
    return 'Draining. Voids and removals still flow; nothing new is issued.';
  return null;
}

export const BLOCK_WORDS: Record<WalletReleaseBlock, string> = {
  plan: 'Plan lacks the wallet',
  source: 'No source picked',
  verified: 'Credentials not verified',
  check: 'Check has not passed',
  round_trip: 'No Test pass saved',
  hold: 'Held by PassBook',
  revoked: 'Revoked',
  legacy: 'Legacy account with no source',
  channel_off: 'Organization blocked the channel',
  org: 'Organization not active',
  org_off: 'Organization turned it Off',
  hold_released: 'Hold released; the organization turns it On',
};

export const blockedWords = (e: WalletReleaseEnrolment) =>
  e.blocks.map((b) => BLOCK_WORDS[b]).join(', ');

export const RELEASE_COPY = {
  title: 'Release',
  noCredentials: 'No credentials',
  noEnrolments: 'No organizations enrolled',
  nothingReady: 'Nothing is ready to turn on',
  dryRun: 'Run dry run',
  apply: 'Apply',
  runAgain: 'Run the dry run again',
  dryRunNote: 'Needs a recent sign-in.',
  wouldOnceReleased: 'These turn on once it is released.',
  changed:
    'The ready list changed since the dry run, or part of it was already applied. Run the dry run again.',
} as const;

export const templateRows = [
  ['ready', 'Ready'],
  ['withOmissions', 'With omissions'],
  ['awaitingReview', 'Awaiting review'],
  ['none', 'None'],
] as const;

export const PARTIAL = 'Some may already be on. Run the dry run again to see what is left.';

export const isReadyChanged = (cause: unknown) =>
  cause instanceof ApiError && cause.code === 'WALLET_RELEASE_READY_CHANGED';

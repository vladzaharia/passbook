import type { WalletProviderInstanceStatus } from '@/shared/contracts/wallet-provider-status.ts';
import type { Tone } from '../lib/status.ts';

export type WalletState = 'not_saved' | 'offered' | 'saved' | 'removed' | 'closed';

export const WALLET_STATE_LABEL: Record<WalletState, string> = {
  not_saved: 'Not saved',
  offered: 'Offered',
  saved: 'Saved',
  removed: 'Removed',
  closed: 'Closed',
};

export const WALLET_STATE_TONE: Record<WalletState, Tone> = {
  not_saved: 'neutral',
  offered: 'neutral',
  saved: 'success',
  removed: 'warning',
  closed: 'neutral',
};

/**
 * What the holder did with the wallet. `offered` is the save link issued, never proof of a save: only the
 * provider's own callback (`reported`) says `saved`.
 */
export function walletState(status: WalletProviderInstanceStatus): WalletState {
  if (
    status.lifecycle === 'revoking' ||
    status.lifecycle === 'revoked' ||
    status.lifecycle === 'retired'
  )
    return 'closed';
  if (status.reported?.event === 'saved') return 'saved';
  if (status.reported?.event === 'removed') return 'removed';
  return status.lifecycle === 'active' ? 'offered' : 'not_saved';
}

/** The wallets a holder can be offered: a provider that is not released is not shown at all. */
export const releasedProviders = (statuses: readonly WalletProviderInstanceStatus[]) =>
  statuses.filter((s) => s.issuance.state === 'enabled');

/**
 * The holder's likely wallet. The admin knows no device, so it follows what the holder did: the wallet they saved
 * to, else the one they were offered, else the first listed. One wallet alone is not a recommendation.
 */
export function recommendedProvider(
  statuses: readonly WalletProviderInstanceStatus[],
): WalletProviderInstanceStatus['provider'] | null {
  if (statuses.length < 2) return null;
  const by = (state: WalletState) => statuses.find((s) => walletState(s) === state);
  return (by('saved') ?? by('offered') ?? statuses[0])?.provider ?? null;
}

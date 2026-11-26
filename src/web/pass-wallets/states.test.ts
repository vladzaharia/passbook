import { describe, expect, it } from 'vitest';
import type { WalletProviderInstanceStatus } from '@/shared/contracts/wallet-provider-status.ts';
import { recommendedProvider, releasedProviders, walletState } from './states.ts';

const status = (
  provider: 'google' | 'samsung',
  over: Partial<WalletProviderInstanceStatus> = {},
): WalletProviderInstanceStatus => ({
  provider,
  lifecycle: 'absent',
  desiredOperation: null,
  priorGenerationRetirementPending: false,
  installation: 'unknown',
  issuance: { state: 'enabled' },
  ...over,
});

describe('walletState', () => {
  it('is Not saved before a save link was issued', () => {
    expect(walletState(status('google'))).toBe('not_saved');
    expect(walletState(status('google', { lifecycle: 'ready' }))).toBe('not_saved');
  });

  it('is Offered once the link was issued, and never Saved on that alone', () => {
    expect(walletState(status('google', { lifecycle: 'active' }))).toBe('offered');
  });

  it('is Saved only when the provider reported a save, and Removed when it reported a removal', () => {
    const at = 1;
    expect(
      walletState(status('google', { lifecycle: 'active', reported: { event: 'saved', at } })),
    ).toBe('saved');
    expect(
      walletState(status('google', { lifecycle: 'active', reported: { event: 'removed', at } })),
    ).toBe('removed');
  });

  it('is Closed for a revoked or retired copy, whatever was reported', () => {
    const reported = { event: 'saved' as const, at: 1 };
    expect(walletState(status('samsung', { lifecycle: 'retired', reported }))).toBe('closed');
    expect(walletState(status('samsung', { lifecycle: 'revoking' }))).toBe('closed');
  });
});

describe('releasedProviders', () => {
  it('drops a provider that is not released', () => {
    const dark = status('samsung', { issuance: { state: 'disabled', reason: 'not_released' } });
    expect(releasedProviders([status('google'), dark]).map((s) => s.provider)).toEqual(['google']);
  });
});

describe('recommendedProvider', () => {
  it('follows the wallet the holder saved to, then the one offered, then the first', () => {
    const saved = status('samsung', { lifecycle: 'active', reported: { event: 'saved', at: 1 } });
    const offered = status('samsung', { lifecycle: 'active' });
    expect(recommendedProvider([status('google'), saved])).toBe('samsung');
    expect(recommendedProvider([status('google'), offered])).toBe('samsung');
    expect(recommendedProvider([status('google'), status('samsung')])).toBe('google');
  });

  it('recommends nothing when only one wallet is shown', () => {
    expect(recommendedProvider([status('google')])).toBeNull();
  });
});

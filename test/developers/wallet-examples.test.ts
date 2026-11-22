import { describe, expect, it } from 'vitest';
import openapi from '../../docs/api/openapi.v1.json';
import { walletProviderEnabled } from '../../src/worker/modules/wallet-providers/provider-policy.ts';
import { examplesOf } from '../../tools/lib/example-lint.ts';
import { darkWalletFailures } from '../../tools/lib/example-wallet.ts';
import type { Doc } from '../../tools/lib/openapi-diff.ts';

// Runs in the worker project: provider-policy.ts is the one place that decides whether a provider is released.
const doc = openapi as unknown as Doc;

describe('wallet examples', () => {
  it('show no provider at work that walletProviderEnabled keeps dark', () => {
    expect(darkWalletFailures(examplesOf(doc), (p) => walletProviderEnabled(p))).toEqual([]);
  });

  it('report each thing only a released provider does', () => {
    const value = {
      walletOffers: [{ provider: 'google', href: 'https://passbook.mobile/p/x/google' }],
      providers: [
        {
          provider: 'samsung',
          lifecycle: 'active',
          desiredOperation: { kind: 'upsert' },
          reported: { event: 'saved' },
        },
      ],
      effective: { google: { on: true } },
      walletIssuance: { samsung: { state: 'enabled' } },
    };
    expect(darkWalletFailures([{ where: 'x', value }], () => false)).toEqual([
      'x.walletOffers[0]: offers a google save while google is not released',
      'x.providers[0].lifecycle: a samsung instance is active while samsung is not released',
      'x.providers[0].desiredOperation: a samsung operation while samsung is not released',
      'x.providers[0].reported: a samsung report while samsung is not released',
      'x.effective.google: the google channel is on while google is not released',
      'x.walletIssuance.samsung: samsung issues while it is not released',
    ]);
    expect(darkWalletFailures([{ where: 'x', value }], () => true)).toEqual([]);
  });
});

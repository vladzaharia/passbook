import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walletProviderEnabled } from '../../src/worker/modules/wallet-providers/provider-policy.ts';
import { examplesOf } from './example-lint.ts';
import { darkWalletFailures } from './example-wallet.ts';
import type { Doc } from './openapi-diff.ts';

const doc = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../docs/api/openapi.v1.json'), 'utf8'),
) as Doc;

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

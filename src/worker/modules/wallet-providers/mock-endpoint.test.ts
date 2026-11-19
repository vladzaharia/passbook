import { describe, expect, it } from 'vitest';
import wranglerConfig from '../../../../wrangler.jsonc?raw';
import { mockProviderInput } from './mock-endpoint.ts';

const dev = {
  WALLET_MOCK_PROVIDERS_URL: 'http://localhost:5175',
  PUBLIC_BASE_URL: 'http://localhost:5173',
};
const google = 'https://walletobjects.googleapis.com/walletobjects/v1/genericClass/1';

describe('mock provider endpoint', () => {
  it('moves provider calls to the local fake in dev', () => {
    expect(mockProviderInput(dev, google)).toBe(
      'http://localhost:5175/walletobjects/v1/genericClass/1',
    );
    expect(mockProviderInput(dev, 'https://oauth2.googleapis.com/token')).toBe(
      'http://localhost:5175/token',
    );
    expect(
      mockProviderInput(dev, 'https://tsapi-card.walletsvc.samsung.com/US/wltex/cards/c1/updates'),
    ).toBe('http://localhost:5175/US/wltex/cards/c1/updates');
  });

  it('leaves other hosts alone', () => {
    expect(mockProviderInput(dev, 'https://example.com/x')).toBe('https://example.com/x');
  });

  it('ignores the var unless both it and the public origin are http loopback', () => {
    const cases = [
      { ...dev, PUBLIC_BASE_URL: 'https://passbook.mobile' },
      { ...dev, PUBLIC_BASE_URL: 'http://passbook.mobile' },
      { ...dev, WALLET_MOCK_PROVIDERS_URL: 'https://localhost:5175' },
      { ...dev, WALLET_MOCK_PROVIDERS_URL: 'http://evil.example:5175' },
      { ...dev, WALLET_MOCK_PROVIDERS_URL: 'http://user:pw@localhost:5175' },
      { ...dev, WALLET_MOCK_PROVIDERS_URL: 'not a url' },
      { PUBLIC_BASE_URL: dev.PUBLIC_BASE_URL },
    ];
    for (const env of cases) expect(mockProviderInput(env, google)).toBe(google);
  });

  it('is never declared in the production Worker config', () => {
    expect(wranglerConfig).not.toMatch(/WALLET_MOCK/);
    expect(wranglerConfig).toMatch(/"PUBLIC_BASE_URL": "https:\/\//);
  });
});

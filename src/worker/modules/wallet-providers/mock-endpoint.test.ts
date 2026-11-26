import { afterEach, describe, expect, it, vi } from 'vitest';
import wranglerConfig from '../../../../wrangler.jsonc?raw';
import type { ServiceContext } from '../../platform/service-context.ts';
import { googleCallbackUrl } from './google-callback-binding.ts';
import { mockProviderInput, mockProvidersUrl, providerFetch } from './mock-endpoint.ts';

const dev = {
  WALLET_MOCK_PROVIDERS_URL: 'http://localhost:5175',
  PUBLIC_BASE_URL: 'http://localhost:5173',
};
const google = 'https://walletobjects.googleapis.com/walletobjects/v1/genericClass/1';
afterEach(() => vi.unstubAllGlobals());

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

  it("moves Google's callback key download to the fake, and leaves it alone outside dev", () => {
    const keys = 'https://pay.google.com/gp/m/issuer/keys';
    expect(mockProviderInput(dev, keys)).toBe('http://localhost:5175/gp/m/issuer/keys');
    expect(mockProviderInput({ PUBLIC_BASE_URL: 'https://passbook.mobile' }, keys)).toBe(keys);
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

  it('moves a provider fetch (credential checks, Samsung card reads) only where it moves the input', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response('{}');
    });
    await providerFetch(dev)(google);
    await providerFetch({ ...dev, PUBLIC_BASE_URL: 'https://passbook.mobile' })(google);
    expect(seen).toEqual(['http://localhost:5175/walletobjects/v1/genericClass/1', google]);
  });

  it('lets the Google callback use the plain-http origin only while the mock stands in for Google', () => {
    const url = (env: object) => googleCallbackUrl({ env } as ServiceContext, 'acc1');
    expect(mockProvidersUrl(dev)?.origin).toBe('http://localhost:5175');
    expect(url(dev)).toBe('http://localhost:5173/wallet/v1/google/acc1');
    expect(url({ PUBLIC_BASE_URL: 'https://passbook.mobile' })).toBe(
      'https://passbook.mobile/wallet/v1/google/acc1',
    );
    for (const env of [
      { PUBLIC_BASE_URL: dev.PUBLIC_BASE_URL },
      { ...dev, PUBLIC_BASE_URL: 'http://passbook.mobile' },
      { ...dev, WALLET_MOCK_PROVIDERS_URL: 'http://evil.example:5175' },
    ])
      expect(() => url(env), JSON.stringify(env)).toThrow();
  });

  it('is never declared in the production Worker config', () => {
    expect(wranglerConfig).not.toMatch(/WALLET_MOCK/);
    expect(wranglerConfig).toMatch(/"PUBLIC_BASE_URL": "https:\/\//);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import wranglerConfig from '../../../../wrangler.jsonc?raw';
import wwdrG4 from '../../../generated/wwdr-g4.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { e2eReleaseRefusal, openE2eRelease } from './e2e-release.ts';
import {
  walletProviderEnabledSql,
  walletProviderIssuance,
  walletProviderReleaseReason,
} from './provider-policy.ts';

/** What tools/e2e-server.ts gives a release run: every runtime signal of the local e2e server. */
let e2e: Record<string, string>;
beforeAll(async () => {
  const fixture = await createFixtureIdentity();
  e2e = {
    WALLET_E2E_RELEASE: '1',
    WALLET_MOCK_PROVIDERS_URL: 'http://localhost:5176',
    PUBLIC_BASE_URL: 'http://localhost:5173',
    SIGNER_PLATFORM_CERTIFICATE: fixture.certificate,
    SIGNER_PLATFORM_INTERMEDIATE: fixture.intermediate,
  };
});

const pem = (text: string) =>
  `-----BEGIN CERTIFICATE-----\n${btoa(text)}\n-----END CERTIFICATE-----\n`;

const expectDark = () => {
  for (const provider of ['google', 'samsung'] as const)
    for (const mode of ['live', 'test'] as const) {
      expect(walletProviderReleaseReason(provider, mode)).toBe('not_released');
      expect(walletProviderIssuance(provider, mode)).toEqual({
        state: 'disabled',
        reason: 'not_released',
      });
    }
  expect(walletProviderEnabledSql('i.provider', 'i.mode')).toBe('1 = 0');
};

describe('e2e release gates', () => {
  it('accepts only the local e2e server: requested, loopback, fixture-signed', () => {
    expect(e2eReleaseRefusal(e2e)).toBeNull();
  });

  it('refuses without the e2e vars file asking for it', () => {
    for (const value of [undefined, '', '0', 'true', ' 1'])
      expect(e2eReleaseRefusal({ ...e2e, WALLET_E2E_RELEASE: value })).toBe('not_requested');
  });

  it('refuses unless provider calls and the public origin are plain-http loopback', () => {
    const production = /"PUBLIC_BASE_URL": "([^"]+)"/.exec(wranglerConfig)?.[1];
    expect(production).toMatch(/^https:\/\//);
    for (const over of [
      { PUBLIC_BASE_URL: production },
      { PUBLIC_BASE_URL: 'http://passbook.mobile' },
      { WALLET_MOCK_PROVIDERS_URL: undefined },
      { WALLET_MOCK_PROVIDERS_URL: 'https://localhost:5176' },
      { WALLET_MOCK_PROVIDERS_URL: 'http://walletobjects.googleapis.com' },
      { WALLET_MOCK_PROVIDERS_URL: 'http://user:pw@localhost:5176' },
    ])
      expect(e2eReleaseRefusal({ ...e2e, ...over }), JSON.stringify(over)).toBe('not_loopback');
  });

  it('refuses a real signer: an Apple certificate or chain, or anything not from the fixture CA', () => {
    for (const over of [
      { SIGNER_PLATFORM_INTERMEDIATE: wwdrG4 },
      { SIGNER_PLATFORM_INTERMEDIATE: undefined },
      { SIGNER_PLATFORM_CERTIFICATE: pem('Wallet Test WWDR, Apple Inc.') },
      { SIGNER_PLATFORM_CERTIFICATE: pem('Pass Type ID: pass.im.plrs.wallet') },
      { SIGNER_PLATFORM_CERTIFICATE: 'replaced-in-tests' },
      {
        SIGNER_PLATFORM_CERTIFICATE: '-----BEGIN CERTIFICATE-----\n%%%\n-----END CERTIFICATE-----',
      },
    ])
      expect(e2eReleaseRefusal({ ...e2e, ...over }), JSON.stringify(over)).toBe('real_signer');
  });

  it('is never declared in the production Worker config', () => {
    expect(wranglerConfig).not.toMatch(/WALLET_E2E/);
    expect(wranglerConfig).not.toMatch(/WALLET_MOCK/);
  });
});

describe('a build without the e2e define (every production build, and this test pool)', () => {
  it('cannot open the providers, even with every e2e runtime signal present', () => {
    expect(e2eReleaseRefusal(e2e)).toBeNull();
    expect(openE2eRelease(e2e)).toBe(false);
    expect(openE2eRelease()).toBe(false);
    expectDark();
  });
});

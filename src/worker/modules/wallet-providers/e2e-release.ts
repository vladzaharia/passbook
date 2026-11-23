import { env } from 'cloudflare:workers';
import { envString } from '../../platform/env.ts';
import { createLogger } from '../../platform/log.ts';
import { mockProvidersUrl } from './mock-endpoint.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';

/**
 * vite.config.ts defines it (tools/lib/e2e-release.ts) only for a tools/e2e-server.ts build started with
 * WALLET_E2E_RELEASE=1. Every other build, and every test run, has it false or absent.
 */
declare const __WALLET_E2E_RELEASE__: boolean | undefined;

/** The throwaway CA of src/passkit/testing/fixture-identity.ts. Apple issues every real pass certificate. */
const FIXTURE_CA = 'Wallet Test WWDR';

export type E2eReleaseRefusal = 'not_requested' | 'not_loopback' | 'real_signer';

/** True only for a PEM certificate issued by the fixture CA, with no Apple name in it. */
function fixtureSigned(pem: string | undefined): boolean {
  const body = pem?.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '') ?? '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) return false;
  const der = atob(body);
  return der.includes(FIXTURE_CA) && !der.includes('Apple');
}

/**
 * Null when every runtime signal says this Worker is the local e2e server in front of test/mock-wallets:
 * the e2e vars file asked for the release, provider calls and the public origin are plain-http loopback
 * (so mock-endpoint.ts sends every provider call to the mock), and the platform signs with the fixture CA.
 */
export function e2eReleaseRefusal(source: object): E2eReleaseRefusal | null {
  if (envString(source, 'WALLET_E2E_RELEASE') !== '1') return 'not_requested';
  if (!mockProvidersUrl(source)) return 'not_loopback';
  if (
    !fixtureSigned(envString(source, 'SIGNER_PLATFORM_CERTIFICATE')) ||
    !fixtureSigned(envString(source, 'SIGNER_PLATFORM_INTERMEDIATE'))
  )
    return 'real_signer';
  return null;
}

/**
 * e2e only (docs/design/wallet-providers/e2e-release.md): opens Google and Samsung in both modes for this
 * isolate. Without the build define this returns at once and the bundler drops the rest of the module;
 * tools/check-bundle.ts fails a Worker bundle that still carries it.
 */
export function openE2eRelease(source: object = env): boolean {
  if (typeof __WALLET_E2E_RELEASE__ === 'undefined' || __WALLET_E2E_RELEASE__ !== true)
    return false;
  const log = createLogger();
  const refusal = e2eReleaseRefusal(source);
  if (refusal) {
    log.error('wallet.e2e_release_refused', { code: 'WALLET_E2E_RELEASE_REFUSED', refusal });
    return false;
  }
  setWalletProvidersEnabledForTest(true);
  log.warn('wallet.e2e_release_open', { code: 'WALLET_E2E_RELEASE' });
  return true;
}

import { env as baseEnv } from 'cloudflare:workers';
import {
  createFixtureIdentity,
  FIXTURE_IDENTITY,
} from '../../src/passkit/testing/fixture-identity.ts';
import type { AppEnv } from '../../src/worker/platform/env.ts';

let identity: ReturnType<typeof createFixtureIdentity> | undefined;

/** One throwaway signing identity per test file; never read from .dev.vars. */
export function fixtureIdentity() {
  identity ??= createFixtureIdentity(FIXTURE_IDENTITY);
  return identity;
}

/** The test env with a freshly generated platform signing identity. */
export async function makeEnv(overrides: Partial<AppEnv> = {}): Promise<AppEnv> {
  const id = await fixtureIdentity();
  // The real APNs mTLS binding from wrangler.jsonc must never reach tests; pass APNS to opt in.
  const { APNS: _apns, ...rest } = baseEnv as AppEnv;
  return {
    ...rest,
    SIGNER_PLATFORM_CERTIFICATE: id.certificate,
    SIGNER_PLATFORM_PRIVATE_KEY: id.privateKey,
    SIGNER_PLATFORM_INTERMEDIATE: id.intermediate,
    ...overrides,
  } as AppEnv;
}

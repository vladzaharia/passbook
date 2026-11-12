import { describe, expect, it } from 'vitest';
import { certificateInfo, signManifest } from '../../src/passkit/sign/index.ts';
import { createFixtureIdentity } from '../../src/passkit/testing/fixture-identity.ts';
import { getIdentityRow } from '../../src/worker/modules/identities/repo.ts';
import { PLATFORM_IDENTITY_ID } from '../../src/worker/modules/identities/resolver.ts';
import { setupKit } from '../../src/worker/modules/passes/pass-test-fixtures.ts';
import { makeEnv } from './env.ts';

describe('test environment signing identity', () => {
  it('signs at the default manual clock, wall time, and well beyond the original CA lifetime', async () => {
    const env = await makeEnv();
    if (!env.SIGNER_PLATFORM_INTERMEDIATE) throw new Error('Missing test intermediate');
    const material = {
      certificate: env.SIGNER_PLATFORM_CERTIFICATE,
      privateKey: env.SIGNER_PLATFORM_PRIVATE_KEY,
      intermediate: env.SIGNER_PLATFORM_INTERMEDIATE,
    };
    const signer = await certificateInfo(material.certificate);
    const ca = await certificateInfo(material.intermediate);
    for (const now of [
      new Date('2026-01-01T00:00:00Z'),
      new Date(),
      new Date('2030-01-01T00:00:00Z'),
    ]) {
      expect(
        signer.notBefore.getTime(),
        `signer notBefore at ${now.toISOString()}`,
      ).toBeLessThanOrEqual(now.getTime());
      expect(
        signer.notAfter.getTime(),
        `signer notAfter at ${now.toISOString()}`,
      ).toBeGreaterThanOrEqual(now.getTime());
      expect(ca.notBefore.getTime(), `CA notBefore at ${now.toISOString()}`).toBeLessThanOrEqual(
        now.getTime(),
      );
      expect(ca.notAfter.getTime(), `CA notAfter at ${now.toISOString()}`).toBeGreaterThanOrEqual(
        now.getTime(),
      );
      try {
        expect(await signManifest(new Uint8Array([1]), material, { now })).toBeInstanceOf(
          Uint8Array,
        );
      } catch (error) {
        throw new Error(`signing at ${now.toISOString()} failed`, { cause: error });
      }
    }
  });

  it('builds a pass through the persisted platform identity at the scan fixture clock', async () => {
    const kit = await setupKit();
    kit.clock.set(Date.UTC(2026, 0, 1, 12));
    const row = await getIdentityRow(kit.env.DB, PLATFORM_IDENTITY_ID);
    expect(row).toMatchObject({
      source: 'env',
      cert_pem: kit.env.SIGNER_PLATFORM_CERTIFICATE,
    });
    const pass = await kit.pass();
    expect(pass.identityId).toBe(PLATFORM_IDENTITY_ID);
  });

  it('retains the short default fixture lifetimes', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const identity = await createFixtureIdentity(undefined, { now });
    const leaf = await certificateInfo(identity.certificate);
    const ca = await certificateInfo(identity.intermediate);
    expect(leaf.notAfter.getTime() - now.getTime()).toBe(2 * 86400_000);
    expect(ca.notAfter.getTime() - now.getTime()).toBe(3 * 86400_000);
  });
});

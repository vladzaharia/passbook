import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import type { SigningMaterial } from '../../../passkit/types.ts';
import { first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { ensurePlatformIdentity } from './repo.ts';
import { createEnvIdentityResolver, PLATFORM_IDENTITY_ID, readEnvIdentity } from './resolver.ts';

let appEnv: AppEnv;
let rotatedIdentity: SigningMaterial;
beforeAll(async () => {
  appEnv = await makeEnv();
  rotatedIdentity = await createFixtureIdentity();
});

async function platformRow() {
  const row = await first<{
    pass_type_identifier: string;
    team_identifier: string;
    cert_pem: string | null;
    cert_sha256: string | null;
    env_material_sha256: string | null;
    is_default: number;
    apns_binding: string | null;
    created_at: number;
    revision: number;
  }>(
    env.DB,
    `SELECT pass_type_identifier, team_identifier, cert_pem, cert_sha256, env_material_sha256,
      is_default, apns_binding, created_at, revision FROM signing_identities WHERE id = ?`,
    [PLATFORM_IDENTITY_ID],
  );
  if (!row) throw new Error('Platform signing identity was not bootstrapped');
  return row;
}

describe('env identity resolver', () => {
  it('reads the platform identity from SIGNER_PLATFORM_* and the platform vars', async () => {
    const identity = await createEnvIdentityResolver(appEnv).platform();
    expect(identity).toMatchObject({
      id: PLATFORM_IDENTITY_ID,
      passTypeIdentifier: 'pass.im.plrs.wallet',
      teamIdentifier: '48H7CLBV8Y',
      orgId: null,
    });
    expect(identity.material.certificate).toContain('BEGIN CERTIFICATE');
  });

  it('falls back to the bundled WWDR G4 when no intermediate is configured', () => {
    const identity = readEnvIdentity({
      ...appEnv,
      SIGNER_PLATFORM_INTERMEDIATE: undefined,
    } as unknown as AppEnv);
    expect(identity.material.intermediate).toContain('BEGIN CERTIFICATE');
    expect(identity.material.intermediate).not.toBe(appEnv.SIGNER_PLATFORM_INTERMEDIATE);
  });

  it('reports push as unavailable without the APNS binding', async () => {
    expect((await createEnvIdentityResolver(appEnv).platform()).apnsBinding).toBeNull();
    expect(readEnvIdentity({ ...appEnv, APNS: {} as Fetcher }).apnsBinding).toBe('APNS');
  });

  it('fails clearly when not configured and for unknown ids', async () => {
    expect(() => readEnvIdentity({ ...appEnv, SIGNER_PLATFORM_CERTIFICATE: '' } as AppEnv)).toThrow(
      /not configured/,
    );
    await expect(createEnvIdentityResolver(appEnv).byId('nope')).rejects.toThrow(/not found/);
  });

  it('upserts the platform signing identity row idempotently', async () => {
    await ensurePlatformIdentity(appEnv, 1);
    const original = await platformRow();
    expect(original).toMatchObject({
      pass_type_identifier: 'pass.im.plrs.wallet',
      team_identifier: '48H7CLBV8Y',
      is_default: 1,
      apns_binding: null,
    });
    expect(original.revision).toBeGreaterThan(0);

    await ensurePlatformIdentity(appEnv, 2);
    expect(await platformRow()).toEqual(original);
  });

  it.each(['pass type', 'team'] as const)(
    'revises the platform identity when its %s changes and changes back',
    async (identifier) => {
      const changedEnv =
        identifier === 'pass type'
          ? { ...appEnv, PLATFORM_PASS_TYPE_ID: 'pass.com.example.rotated' }
          : { ...appEnv, PLATFORM_TEAM_ID: 'TEAM123456' };
      await ensurePlatformIdentity(appEnv, 1);
      const original = await platformRow();

      await ensurePlatformIdentity(changedEnv, 2);
      const changed = await platformRow();
      expect(changed).toMatchObject(
        identifier === 'pass type'
          ? { pass_type_identifier: 'pass.com.example.rotated' }
          : { team_identifier: 'TEAM123456' },
      );
      expect(changed.cert_sha256).toBe(original.cert_sha256);
      expect(changed.revision).toBeGreaterThan(original.revision);

      await ensurePlatformIdentity(changedEnv, 3);
      expect(await platformRow()).toEqual(changed);
      await ensurePlatformIdentity(appEnv, 4);
      const restored = await platformRow();
      expect(restored.revision).toBeGreaterThan(changed.revision);
      expect({ ...restored, revision: original.revision }).toEqual(original);
    },
  );

  it.each(['certificate', 'private key', 'intermediate', 'full material'] as const)(
    'revises the platform identity when %s changes and changes back',
    async (material) => {
      // Single-component cases intentionally isolate bootstrap change detection, not key-pair validation.
      const changedEnv =
        material === 'certificate'
          ? { ...appEnv, SIGNER_PLATFORM_CERTIFICATE: rotatedIdentity.certificate }
          : material === 'private key'
            ? { ...appEnv, SIGNER_PLATFORM_PRIVATE_KEY: rotatedIdentity.privateKey }
            : material === 'intermediate'
              ? { ...appEnv, SIGNER_PLATFORM_INTERMEDIATE: rotatedIdentity.intermediate }
              : {
                  ...appEnv,
                  SIGNER_PLATFORM_CERTIFICATE: rotatedIdentity.certificate,
                  SIGNER_PLATFORM_PRIVATE_KEY: rotatedIdentity.privateKey,
                  SIGNER_PLATFORM_INTERMEDIATE: rotatedIdentity.intermediate,
                };
      await ensurePlatformIdentity(appEnv, 1);
      const original = await platformRow();

      await ensurePlatformIdentity(changedEnv, 2);
      const changed = await platformRow();
      expect(changed.revision).toBeGreaterThan(original.revision);
      if (material === 'certificate' || material === 'full material') {
        expect(changed.cert_pem).toBe(rotatedIdentity.certificate);
        expect(changed.cert_sha256).not.toBe(original.cert_sha256);
      } else {
        expect(changed.cert_pem).toBe(original.cert_pem);
        expect(changed.cert_sha256).toBe(original.cert_sha256);
      }
      if (material !== 'certificate') {
        expect(changed.env_material_sha256).not.toBe(original.env_material_sha256);
      }

      await ensurePlatformIdentity(changedEnv, 3);
      expect(await platformRow()).toEqual(changed);
      await ensurePlatformIdentity(appEnv, 4);
      const restored = await platformRow();
      expect(restored.revision).toBeGreaterThan(changed.revision);
      expect({ ...restored, revision: original.revision }).toEqual(original);
    },
  );

  it('revises the platform identity when the APNs binding changes and changes back', async () => {
    const changedEnv = { ...appEnv, APNS: {} as Fetcher };
    await ensurePlatformIdentity(appEnv, 1);
    const original = await platformRow();

    await ensurePlatformIdentity(changedEnv, 2);
    const changed = await platformRow();
    expect(changed.apns_binding).toBe('APNS');
    expect(changed.cert_sha256).toBe(original.cert_sha256);
    expect(changed.revision).toBeGreaterThan(original.revision);

    await ensurePlatformIdentity(changedEnv, 3);
    expect(await platformRow()).toEqual(changed);
    await ensurePlatformIdentity(appEnv, 4);
    const restored = await platformRow();
    expect(restored.revision).toBeGreaterThan(changed.revision);
    expect({ ...restored, revision: original.revision }).toEqual(original);
  });
});

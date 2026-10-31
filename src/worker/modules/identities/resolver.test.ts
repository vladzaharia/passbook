import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { ensurePlatformIdentity } from './repo.ts';
import { createEnvIdentityResolver, PLATFORM_IDENTITY_ID, readEnvIdentity } from './resolver.ts';

let appEnv: AppEnv;
beforeAll(async () => {
  appEnv = await makeEnv();
});

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
    await ensurePlatformIdentity(appEnv, 2);
    const row = await first<{
      pass_type_identifier: string;
      is_default: number;
      apns_binding: string | null;
    }>(
      env.DB,
      "SELECT pass_type_identifier, is_default, apns_binding FROM signing_identities WHERE id = 'platform'",
    );
    expect(row).toEqual({
      pass_type_identifier: 'pass.im.plrs.wallet',
      is_default: 1,
      apns_binding: null,
    });
  });
});

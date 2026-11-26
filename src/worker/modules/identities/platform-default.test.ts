import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { resolveDefaultPlatform } from './db-resolver.ts';
import { setPlatformDefault } from './platform-default.ts';
import { getIdentityRow } from './repo.ts';
import { ensurePlatformIdentity } from './repo-platform.ts';
import { defaultPlatformPassIdentity, switchDefault } from './repo-platform-default.ts';
import { createIdentityResolver } from './resolver.ts';

const actor: Actor = { type: 'system', id: null };
let kit: Kit;

async function slotRow(
  over: Partial<{
    health: string;
    issuing: number;
    certPem: string | null;
    notAfter: number;
    purpose: string;
    orgId: string | null;
    id: string;
    passType: string;
  }> = {},
) {
  const id = over.id ?? 'slot-root';
  await run(
    kit.env.DB,
    "INSERT OR IGNORE INTO credentials (id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at) VALUES (?, ?, 1, x'00', x'00', x'00', 1)".replace(
      '?, ?,',
      "?, 'pass_signer',",
    ),
    [`cred-${id}`],
  );
  await run(
    kit.env.DB,
    `INSERT INTO signing_identities
       (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, cert_pem, not_after,
        provenance, purpose, apns_health, is_default, issuing, created_at)
     VALUES (?, ?, ?, ?, 'TEAM123456', 'db', ?, ?, ?, 'platform', ?, ?, 0, ?, 1)`,
    [
      id,
      over.orgId ?? null,
      id,
      over.passType ?? 'pass.mobile.passbook',
      `cred-${id}`,
      over.certPem === undefined ? 'PEM' : over.certPem,
      over.notAfter ?? kit.clock.now() + 90 * 86_400_000,
      over.purpose ?? 'passes',
      over.health ?? 'healthy',
      over.issuing ?? 1,
    ],
  );
  return id;
}

/** The owner's device test: a pass signed by the identity that a device registered. */
async function deviceTest(identityId: string) {
  const pass = await kit.pass();
  await run(
    kit.env.DB,
    'INSERT INTO devices (device_id, identity_id, push_token, updated_at) VALUES (?, ?, ?, ?)',
    ['dev-1', identityId, 't', kit.clock.now()],
  );
  await run(
    kit.env.DB,
    'INSERT INTO registrations (device_id, identity_id, pass_id, created_at) VALUES (?, ?, ?, ?)',
    ['dev-1', identityId, pass.id, kit.clock.now()],
  );
}

const flags = (id: string) =>
  first<{ is_default: number; issuing: number }>(
    kit.env.DB,
    'SELECT is_default, issuing FROM signing_identities WHERE id = ?',
    [id],
  );
const notReady = { code: 'IDENTITY_NOT_READY' };

beforeEach(async () => {
  kit = await setupKit();
  await run(kit.env.DB, 'DELETE FROM registrations');
  await run(kit.env.DB, 'DELETE FROM devices');
  await run(kit.env.DB, "DELETE FROM signing_identities WHERE id LIKE 'slot-%'");
  await run(kit.env.DB, "DELETE FROM credentials WHERE id LIKE 'cred-slot-%'");
  await run(
    kit.env.DB,
    "UPDATE signing_identities SET is_default = 1, issuing = 1 WHERE id = 'platform'",
  );
});

describe('setPlatformDefault', () => {
  it('moves the default, stops the legacy row issuing and audits, after every check', async () => {
    const id = await slotRow();
    await deviceTest(id);
    expect(await setPlatformDefault(kit.ctx, actor, id)).toEqual({ changed: true });
    expect(await flags(id)).toEqual({ is_default: 1, issuing: 1 });
    expect(await flags('platform')).toEqual({ is_default: 0, issuing: 0 });
    const audit = await all<{ action: string; target_id: string }>(
      kit.env.DB,
      "SELECT action, target_id FROM audit_log WHERE action = 'identity.platform_default_changed'",
    );
    expect(audit).toEqual([{ action: 'identity.platform_default_changed', target_id: id }]);
    // A repeat changes nothing and writes no second audit row.
    expect(await setPlatformDefault(kit.ctx, actor, id)).toEqual({ changed: false });
    expect(
      (
        await all(
          kit.env.DB,
          "SELECT 1 FROM audit_log WHERE action = 'identity.platform_default_changed'",
        )
      ).length,
    ).toBe(1);
  });

  it('refuses without a healthy push, and writes nothing', async () => {
    for (const health of ['unknown', 'failing']) {
      const id = await slotRow({
        health,
        id: `slot-${health}`,
        passType: `pass.mobile.passbook.${health}`,
      });
      await deviceTest(id);
      await expect(setPlatformDefault(kit.ctx, actor, id)).rejects.toMatchObject(notReady);
    }
    expect(await flags('platform')).toEqual({ is_default: 1, issuing: 1 });
  });

  it('refuses without the device test (no registered device)', async () => {
    const id = await slotRow();
    await expect(setPlatformDefault(kit.ctx, actor, id)).rejects.toMatchObject(notReady);
    expect(await flags('platform')).toEqual({ is_default: 1, issuing: 1 });
  });

  it.each([
    ['no certificate yet', { certPem: null }],
    ['an expired certificate', { notAfter: 1 }],
    ['not issuing', { issuing: 0 }],
    ['a device-test row', { purpose: 'device_test' }],
  ])('refuses %s', async (_name, over) => {
    const id = await slotRow(over);
    await deviceTest(id);
    await expect(setPlatformDefault(kit.ctx, actor, id)).rejects.toMatchObject(notReady);
    expect(await flags(id)).toMatchObject({ is_default: 0 });
    expect(await flags('platform')).toEqual({ is_default: 1, issuing: 1 });
  });

  it('refuses an org-owned row and an unknown id', async () => {
    const id = await slotRow({ orgId: kit.org.id });
    await deviceTest(id);
    await expect(setPlatformDefault(kit.ctx, actor, id)).rejects.toMatchObject(notReady);
    await expect(setPlatformDefault(kit.ctx, actor, 'nope')).rejects.toMatchObject({
      code: 'IDENTITY_NOT_FOUND',
    });
  });

  it('the atomic batch re-checks: a certificate that expired after the read changes nothing', async () => {
    const id = await slotRow();
    await deviceTest(id);
    const row = await getIdentityRow(kit.env.DB, id);
    if (!row) throw new Error('missing row');
    const moved = await switchDefault(
      kit.env.DB,
      kit.ctx,
      row,
      kit.clock.now() + 365 * 86_400_000,
      {
        actorType: 'system',
        action: 'identity.platform_default_changed',
      },
    );
    expect(moved).toBe(false);
    expect(await flags('platform')).toEqual({ is_default: 1, issuing: 1 });
    expect(await flags(id)).toMatchObject({ is_default: 0 });
  });

  it('reverses: targeting platform makes it the default and issuing again', async () => {
    const id = await slotRow();
    await deviceTest(id);
    await setPlatformDefault(kit.ctx, actor, id);
    expect(await setPlatformDefault(kit.ctx, actor, 'platform')).toEqual({ changed: true });
    expect(await flags('platform')).toEqual({ is_default: 1, issuing: 1 });
    expect(await flags(id)).toMatchObject({ is_default: 0 });
  });

  it('refuses the reverse flip while the legacy env material is gone', async () => {
    const id = await slotRow();
    await deviceTest(id);
    await setPlatformDefault(kit.ctx, actor, id);
    const env = { ...kit.env, SIGNER_PLATFORM_CERTIFICATE: '', SIGNER_PLATFORM_PRIVATE_KEY: '' };
    await expect(setPlatformDefault({ ...kit.ctx, env }, actor, 'platform')).rejects.toMatchObject(
      notReady,
    );
    expect(await flags(id)).toMatchObject({ is_default: 1 });
  });
});

describe('after the flip', () => {
  const stripEnv = () => ({
    ...kit.env,
    SIGNER_PLATFORM_CERTIFICATE: '',
    SIGNER_PLATFORM_PRIVATE_KEY: '',
  });

  it('new passes resolve to the new default; the legacy row still serves its own passes', async () => {
    const id = await slotRow();
    await deviceTest(id);
    await setPlatformDefault(kit.ctx, actor, id);
    expect(
      await defaultPlatformPassIdentity(kit.env.DB, {
        passTypeIdentifier: 'x',
        teamIdentifier: 'y',
      }),
    ).toEqual({
      passTypeIdentifier: 'pass.mobile.passbook',
      teamIdentifier: 'TEAM123456',
    });
    // The legacy pass type is kept as the env fallback and as the row's own value.
    const row = await first<{ pass_type_identifier: string }>(
      kit.env.DB,
      "SELECT pass_type_identifier FROM signing_identities WHERE id = 'platform'",
    );
    expect(row?.pass_type_identifier).toBe('pass.im.plrs.wallet');
    expect((await createIdentityResolver(kit.env).byId('platform')).passTypeIdentifier).toBe(
      'pass.im.plrs.wallet',
    );
  });

  it('with the env material removed, ensure is a no-op and the row stays', async () => {
    const id = await slotRow();
    await deviceTest(id);
    await setPlatformDefault(kit.ctx, actor, id);
    const env = stripEnv();
    await expect(
      ensurePlatformIdentity(env, kit.clock.now(), kit.ctx.log),
    ).resolves.toBeUndefined();
    expect(await flags('platform')).toEqual({ is_default: 0, issuing: 0 });
    await expect(createIdentityResolver(env).byId('platform')).rejects.toMatchObject({
      code: 'IDENTITY_RETIRED',
    });
    // New passes resolve through the default row, never the removed env material.
    await expect(resolveDefaultPlatform(env)).rejects.not.toMatchObject({
      code: 'IDENTITY_RETIRED',
    });
  });

  it('with the env material removed and the row still issuing, ensure still reports not configured', async () => {
    await expect(
      ensurePlatformIdentity(stripEnv(), kit.clock.now(), kit.ctx.log),
    ).rejects.toMatchObject({ code: 'IDENTITY_NOT_CONFIGURED' });
  });

  it('with no platform default row, readers fall back to the env values', async () => {
    const fallback = { passTypeIdentifier: 'pass.im.plrs.wallet', teamIdentifier: 'T' };
    await run(kit.env.DB, 'UPDATE signing_identities SET is_default = 0');
    expect(await defaultPlatformPassIdentity(kit.env.DB, fallback)).toEqual(fallback);
  });
});

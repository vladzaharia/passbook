// WA1d: a refused legacy account is resolved by a platform admin (assign, merge, retire), and each clears the gate.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { runCredentialMigrate } from './credential-migrate.ts';
import { resolveMigration } from './credential-migrate-resolve.ts';
import {
  currentIds,
  pendingAmong,
  type Seeded,
  seedLegacy,
  stateOf,
} from './credential-migrate-test-fixtures.ts';
import { savePlatformCredential } from './credential-service.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
beforeAll(async () => {
  k = await kit();
}, 30_000);

const migrate = (a: Seeded) =>
  runCredentialMigrate(createJobContext(k.env, 'wallet.credential_migrate'), a.id);
const input = (a: Seeded, action: 'assign_platform' | 'merge' | 'retire') => ({
  orgId: a.orgId,
  mode: a.mode,
  provider: a.provider,
  action,
});
const platformOf = (mode: string, provider: string) =>
  first<{ id: string; identity_hash: string }>(
    env.DB,
    "SELECT id, identity_hash FROM wallet_credentials WHERE scope = 'platform' AND mode = ? AND provider = ? AND revoked_at IS NULL",
    [mode, provider],
  );
const auditCount = async (orgId: string) =>
  (
    await first<{ n: number }>(
      env.DB,
      "SELECT count(*) AS n FROM audit_log WHERE org_id = ? AND action = 'wallet_provider.migration_resolve'",
      [orgId],
    )
  )?.n;

/** Two orgs on one issuer: the first migrates onto an org credential, the second is refused. */
async function collide(mode: 'live' | 'test', provider: 'google' | 'samsung', id: string) {
  const creds =
    provider === 'google' ? k.google(id) : { ...k.samsung('card-shared'), partnerId: id };
  const first = await seedLegacy(k, (await k.org()).id, mode, provider, creds);
  const second = await seedLegacy(k, (await k.org()).id, mode, provider, creds);
  expect(await migrate(first)).toBe('migrated');
  expect(await migrate(second)).toBe('refused');
  return { first, second, creds };
}

describe('assign platform (test Google)', () => {
  it('points the refused account at the platform credential of its identity; ids stay', async () => {
    const admin = await k.admin();
    const { first: f, second: g } = await collide('test', 'google', '710100100');
    const platform = await savePlatformCredential(k.ctx, admin.auth, {
      mode: 'test',
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('710100100'),
    });
    const ids = await currentIds(k, g);
    expect(await resolveMigration(k.ctx, admin.auth, input(g, 'assign_platform'))).toEqual({
      accounts: 1,
    });
    expect(await stateOf(g.id)).toMatchObject({
      revision: 1,
      enrolment_revision: 1,
      credential_source_id: platform.id,
      has_hmac: 1,
      source_scope: 'platform',
    });
    expect(await currentIds(k, g)).toEqual(ids);
    expect(await auditCount(g.orgId)).toBe(1);
    // The first account, already on its org credential with the same identity, switches too.
    await resolveMigration(k.ctx, admin.auth, input(f, 'assign_platform'));
    expect(await stateOf(f.id)).toMatchObject({ enrolment_revision: 2, source_scope: 'platform' });
    expect(await pendingAmong([f.id, g.id])).toEqual([]);
    // Assigned again, or to a platform credential of another identity, it is refused.
    await expect(
      resolveMigration(k.ctx, admin.auth, input(g, 'assign_platform')),
    ).rejects.toMatchObject({ code: 'WALLET_ACCOUNT_CONFLICT' });
    const other = await seedLegacy(k, (await k.org()).id, 'test', 'google', k.google('710200200'));
    await expect(
      resolveMigration(k.ctx, admin.auth, input(other, 'assign_platform')),
    ).rejects.toMatchObject({ code: 'WALLET_IDENTITY_IMMUTABLE' });
    expect(await pendingAmong([other.id])).toEqual([other.id]);
  });

  it('is for platform admins only', async () => {
    const org = await k.org();
    const a = await seedLegacy(k, org.id, 'test', 'google', k.google('710300300'));
    const member = await k.member(org.id, 'test');
    await expect(
      resolveMigration(k.ctx, member.auth, input(a, 'assign_platform')),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('merge (live Google)', () => {
  it('promotes the shared identity to a platform credential, moves both accounts, revokes the duplicate', async () => {
    const admin = await k.admin();
    const { first: f, second: g } = await collide('live', 'google', '720100100');
    expect(await platformOf('live', 'google')).toBeNull();
    const orgCredential = (
      await first<{ id: string }>(env.DB, 'SELECT id FROM wallet_credentials WHERE org_id = ?', [
        f.orgId,
      ])
    )?.id;
    const before = [await currentIds(k, f), await currentIds(k, g)];
    expect(await resolveMigration(k.ctx, admin.auth, input(g, 'merge'))).toEqual({ accounts: 2 });
    const platform = await platformOf('live', 'google');
    for (const [i, a] of [f, g].entries()) {
      expect(await stateOf(a.id)).toMatchObject({
        credential_source_id: platform?.id,
        source_scope: 'platform',
        revision: 1,
      });
      expect(await currentIds(k, a)).toEqual(before[i]);
    }
    expect(
      (
        await first<{ gone: number }>(
          env.DB,
          'SELECT revoked_at IS NOT NULL AS gone FROM wallet_credentials WHERE id = ?',
          [orgCredential ?? ''],
        )
      )?.gone,
    ).toBe(1);
    expect(await pendingAmong([f.id, g.id])).toEqual([]);
    // A rerun finds nothing left to move.
    expect(await resolveMigration(k.ctx, admin.auth, input(g, 'merge'))).toEqual({ accounts: 0 });
  });

  it('refuses while a platform credential of another identity exists', async () => {
    const admin = await k.admin();
    const { second } = await collide('test', 'samsung', 'P-OTHER-1');
    await savePlatformCredential(k.ctx, admin.auth, {
      mode: 'test',
      provider: 'samsung',
      expectedRevision: 0,
      credentials: { ...k.samsung('card-platform'), partnerId: 'P-PLATFORM' },
    });
    await expect(resolveMigration(k.ctx, admin.auth, input(second, 'merge'))).rejects.toMatchObject(
      { code: 'WALLET_ACCOUNT_CONFLICT' },
    );
    expect(await pendingAmong([second.id])).toEqual([second.id]);
  });
});

describe('retire (live Samsung)', () => {
  it('revokes the legacy account and the gate clears', async () => {
    const admin = await k.admin();
    const { first: f, second: g } = await collide('live', 'samsung', 'P-RETIRE-1');
    expect(await pendingAmong([f.id, g.id])).toEqual([g.id]);
    expect(await resolveMigration(k.ctx, admin.auth, input(g, 'retire'))).toEqual({ accounts: 1 });
    const state = await stateOf(g.id);
    expect(state.revision).toBe(2);
    expect(state.revoked_at).not.toBeNull();
    expect(await pendingAmong([f.id, g.id])).toEqual([]);
    expect(await auditCount(g.orgId)).toBe(1);
    await expect(resolveMigration(k.ctx, admin.auth, input(g, 'retire'))).rejects.toMatchObject({
      code: 'WALLET_ACCOUNT_CONFLICT',
    });
  });
});

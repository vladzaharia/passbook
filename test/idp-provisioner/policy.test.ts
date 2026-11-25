import { beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../../workers/idp-provisioner/src/api.ts';
import { fakePocket } from './fake-pocket.ts';
import { baseEnv, captureLogs, ledger, resetLedger, seedGrant, setup } from './harness.ts';

beforeEach(resetLedger);

describe('signup body', () => {
  it.each(['v2', 'admin'] as const)('is fixed whatever the caller sends (%s)', async (layout) => {
    const { api, pocket } = setup(layout);
    const hostile = api.createSignup as unknown as (...a: unknown[]) => Promise<unknown>;
    await hostile('ref-1', { userGroupIds: ['g-admins'], ttl: '999h', usageLimit: 100 });
    const post = pocket.writes().find((w) => w.method === 'POST');
    expect(post?.body).toEqual({ ttl: '1h', usageLimit: 1, userGroupIds: ['g-dev'] });
    expect(post?.path).toBe(layout === 'admin' ? '/api/admin/signup-tokens' : '/api/signup-tokens');
  });

  it.each([
    ['an object', { userGroupIds: ['g-admins'] }],
    ['a path', '../users'],
    ['an empty string', ''],
    ['a long string', 'a'.repeat(65)],
    ['an email', 'a@b.test'],
  ])('refuses %s as the ref, with no Pocket ID call', async (_n, ref) => {
    const { api, pocket } = setup();
    await expect(api.createSignup(ref as never)).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.s.seen).toHaveLength(0);
  });
});

interface Change {
  reason: string;
  name: string;
  /** Settings to set; null removes the key. */
  config?: Record<string, string | null>;
  groupName?: string;
}
const unsafe: Change[] = [
  { reason: 'signups_not_token', name: 'signups open', config: { allowUserSignups: 'open' } },
  { reason: 'signups_not_token', name: 'signups off', config: { allowUserSignups: 'disabled' } },
  {
    reason: 'email_verification_not_required',
    name: 'optional',
    config: { emailVerification: 'optional' },
  },
  {
    reason: 'email_verification_not_required',
    name: 'off',
    config: { emailVerification: 'disabled' },
  },
  { reason: 'require_email_off', name: 'email optional', config: { requireUserEmail: 'false' } },
  { reason: 'emails_verified_on', name: 'emails verified', config: { emailsVerified: 'true' } },
  { reason: 'emails_verified_on', name: 'missing key', config: { emailsVerified: null } },
  {
    reason: 'default_groups_set',
    name: 'default group',
    config: { signupDefaultUserGroupIDs: '["g-other"]' },
  },
  { reason: 'default_groups_set', name: 'unparsable', config: { signupDefaultUserGroupIDs: 'x' } },
  { reason: 'group_name_mismatch', name: 'renamed group', groupName: 'passbook_other' },
];

describe('IDP_UNSAFE_CONFIG refuses every write', () => {
  it.each(unsafe)('$reason ($name)', async ({ reason, config, groupName }) => {
    const { api, pocket } = setup();
    for (const [k, v] of Object.entries(config ?? {})) {
      if (v === null) delete pocket.s.config[k];
      else pocket.s.config[k] = v;
    }
    if (groupName) pocket.s.groupName = groupName;
    pocket.addUser('u1');
    await seedGrant('u1');
    const health = await api.health();
    expect(health.ok).toBe(false);
    expect(health.unsafe).toContain(reason);
    const logs = await captureLogs(async () => {
      await expect(api.createSignup('r1')).rejects.toThrow(/^IDP_UNSAFE_CONFIG/);
      await expect(api.addDeveloper('u1', 'r1')).rejects.toThrow(/^IDP_UNSAFE_CONFIG/);
      await expect(api.removeDeveloper('u1', 'removed')).rejects.toThrow(/^IDP_UNSAFE_CONFIG/);
    });
    expect(pocket.writes()).toHaveLength(0);
    expect(logs.lines.some((l) => l.includes('provisioner.unsafe_config'))).toBe(true);
    const refused = (await ledger()).filter((r) => r.phase === 'refused');
    expect(refused).toHaveLength(3);
    expect(refused.every((r) => r.status === 'IDP_UNSAFE_CONFIG')).toBe(true);
  });

  it('refuses a group that is protected', async () => {
    const { api, pocket } = setup('v2', { DEVELOPER_GROUP_NAME: 'wallet_admins' });
    pocket.s.groupName = 'wallet_admins';
    const health = await api.health();
    expect(health.unsafe).toContain('group_protected');
    await expect(api.createSignup('r1')).rejects.toThrow(/^IDP_UNSAFE_CONFIG/);
    expect(pocket.s.seen).toHaveLength(0);
  });

  it('refuses a group id that does not resolve, and says the layout may be wrong', async () => {
    const { api, pocket } = setup('v2', { DEVELOPER_GROUP_ID: 'g-missing' });
    const health = await api.health();
    expect(health).toMatchObject({ ok: false, layoutSuspect: true });
    expect(health.unsafe).toContain('group_not_found');
    await expect(api.createSignup('r1')).rejects.toThrow(/^IDP_UNSAFE_CONFIG/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('reports a wrong route layout as a 404 on the group read', async () => {
    const pocket = fakePocket('admin', { now: 0 });
    const api = createApi(baseEnv('v2'), { fetch: pocket.fetch, now: () => 0 });
    const health = await api.health();
    expect(health).toMatchObject({ ok: false, layoutSuspect: true, layout: 'v2' });
  });

  it.each([
    ['env_group_id', { DEVELOPER_GROUP_ID: '' }],
    ['env_group_name', { DEVELOPER_GROUP_NAME: '' }],
    ['env_layout', { POCKET_ID_API: 'v3' }],
    ['env_key', { POCKET_ID_API_KEY: '' }],
    ['env_origin', { POCKET_ID_ORIGIN: 'http://id.test' }],
    ['env_origin', { POCKET_ID_ORIGIN: 'https://id.test/api' }],
    ['env_origin', { POCKET_ID_ORIGIN: 'https://user@id.test' }],
  ])('refuses bad settings %s without any request', async (reason, patch) => {
    const { api, pocket } = setup('v2', patch);
    expect((await api.health()).unsafe).toContain(reason);
    await expect(api.createSignup('r1')).rejects.toThrow(/^IDP_UNSAFE_CONFIG/);
    expect(pocket.s.seen).toHaveLength(0);
  });
});

describe('health cache', () => {
  it('reads Pocket ID once per ten minutes, and reports the key expiry', async () => {
    const { api, pocket, clock } = setup();
    const first = await api.health();
    expect(first).toMatchObject({ ok: true, groupName: 'passbook_developers' });
    expect(first.keyExpiresAt).toBe(Date.parse('2027-02-20T00:00:00Z'));
    const reads = pocket.s.seen.length;
    expect(reads).toBe(3);
    await api.createSignup('r1');
    await api.health();
    expect(pocket.s.seen.filter((s) => s.method === 'GET')).toHaveLength(reads);
    clock.now += 11 * 60_000;
    pocket.s.config.allowUserSignups = 'open';
    await expect(api.createSignup('r2')).rejects.toThrow(/^IDP_UNSAFE_CONFIG/);
  });

  it('re-reads an unsafe answer after a minute', async () => {
    const { api, pocket, clock } = setup();
    pocket.s.config.emailsVerified = 'true';
    expect((await api.health()).ok).toBe(false);
    pocket.s.config.emailsVerified = 'false';
    expect((await api.health()).ok).toBe(false);
    clock.now += 61_000;
    expect((await api.health()).ok).toBe(true);
  });

  it('reads the right routes per layout', async () => {
    const v2 = setup('v2');
    await v2.api.health();
    expect(v2.pocket.s.seen.map((s) => s.path)).toEqual([
      '/api/user-groups/g-dev',
      '/api/application-configuration/all',
      '/api/api-keys',
    ]);
    const admin = setup('admin');
    await admin.api.health();
    expect(admin.pocket.s.seen.map((s) => s.path)).toEqual([
      '/api/admin/user-groups/g-dev',
      '/api/admin/application-configuration',
      '/api/api-keys',
    ]);
  });
});

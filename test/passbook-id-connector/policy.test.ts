import { beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../../workers/passbook-id-connector/src/api.ts';
import { fakePocket } from './fake-pocket.ts';
import {
  baseEnv,
  captureLogs,
  ctx,
  groupsJson,
  ledger,
  resetLedger,
  seedGrant,
  setup,
} from './harness.ts';

beforeEach(resetLedger);

describe('signup body', () => {
  it.each([
    ['member', ['g-console']],
    ['developer', ['g-dev']],
    ['member_developer', ['g-dev', 'g-console']],
  ] as const)(
    'is fixed by the kind %s whatever the caller sends (both layouts)',
    async (kind, ids) => {
      for (const layout of ['v2', 'admin'] as const) {
        await resetLedger();
        const { api, pocket } = setup(layout);
        const hostile = api.createSignup as unknown as (...a: unknown[]) => Promise<unknown>;
        await hostile({ kind }, ctx(), {
          userGroupIds: ['g-admins'],
          ttl: '999h',
          usageLimit: 100,
        });
        const post = pocket.writes().find((w) => w.method === 'POST');
        expect(post?.body).toEqual({ ttl: '1h', usageLimit: 1, userGroupIds: ids });
        expect(post?.path).toBe(
          layout === 'admin' ? '/api/admin/signup-tokens' : '/api/signup-tokens',
        );
      }
    },
  );

  it.each([
    ['an object', { userGroupIds: ['g-admins'] }],
    ['a group id', 'g-admins'],
    ['a role name', 'console'],
    ['an empty string', ''],
    ['nothing', undefined],
  ])('refuses %s as the kind, with no Polaris ID call', async (_n, kind) => {
    const { api, pocket } = setup();
    await expect(api.createSignup(kind as never, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.s.seen).toHaveLength(0);
  });

  it('refuses a kind whose role the registry does not map', async () => {
    const { api, pocket } = setup('v2', {
      GROUPS: JSON.stringify({
        developer: { id: 'g-dev', name: 'passbook_developers' },
        platform_admin: { id: 'g-admins', name: 'passbook_platform_admins', protected: true },
      }),
    });
    await expect(api.createSignup({ kind: 'member' }, ctx())).rejects.toThrow(
      /^IDP_REFUSED: Role console is not mapped/,
    );
    await expect(api.createSignup({ kind: 'developer' }, ctx())).resolves.toMatchObject({
      tokenId: 'tok-id-1',
    });
    expect(pocket.writes()).toHaveLength(1);
  });

  it.each([
    ['a path ref', { ...ctx(), ref: '../users' }],
    ['a long ref', { ...ctx(), ref: 'a'.repeat(65) }],
    ['an email ref', { ...ctx(), ref: 'a@b.test' }],
  ])('refuses %s', async (_n, bad) => {
    const { api, pocket } = setup();
    await expect(api.createSignup({ kind: 'member' }, bad)).rejects.toThrow(/^IDP_REFUSED/);
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
  { reason: 'group_name_mismatch:developer', name: 'renamed group', groupName: 'passbook_other' },
];

describe('IDP_UNSAFE_CONFIG refuses every write', () => {
  it.each(unsafe)('$reason ($name)', async ({ reason, config, groupName }) => {
    const { api, pocket } = setup();
    for (const [k, v] of Object.entries(config ?? {})) {
      if (v === null) delete pocket.s.config[k];
      else pocket.s.config[k] = v;
    }
    if (groupName) pocket.s.groupNames['g-dev'] = groupName;
    pocket.addUser('u1');
    await seedGrant('u1', 'console');
    const health = await api.health();
    expect(health.ok).toBe(false);
    expect(health.unsafe).toContain(reason);
    const logs = await captureLogs(async () => {
      await expect(api.createSignup({ kind: 'member' }, ctx())).rejects.toThrow(
        /^IDP_UNSAFE_CONFIG/,
      );
      await expect(api.apply('u1', { add: ['developer'] }, ctx())).rejects.toThrow(
        /^IDP_UNSAFE_CONFIG/,
      );
      await expect(api.apply('u1', { remove: ['console'] }, ctx())).rejects.toThrow(
        /^IDP_UNSAFE_CONFIG/,
      );
      await expect(api.setDisabled('u1', true, ctx())).rejects.toThrow(/^IDP_UNSAFE_CONFIG/);
    });
    expect(pocket.writes()).toHaveLength(0);
    expect(logs.lines.some((l) => l.includes('binding.unsafe_config'))).toBe(true);
    const refused = (await ledger()).filter((r) => r.phase === 'refused');
    expect(refused).toHaveLength(4);
    expect(refused.every((r) => r.status === 'IDP_UNSAFE_CONFIG')).toBe(true);
  });

  it('refuses a writable group named like a protected one', async () => {
    const groups = JSON.parse(groupsJson());
    groups.developer.name = 'passbook_platform_admins';
    const { api, pocket } = setup('v2', { GROUPS: JSON.stringify(groups) });
    pocket.s.groupNames['g-dev'] = 'passbook_platform_admins';
    expect((await api.health()).unsafe).toContain('group_protected');
    await expect(api.createSignup({ kind: 'developer' }, ctx())).rejects.toThrow(
      /^IDP_UNSAFE_CONFIG/,
    );
    expect(pocket.s.seen).toHaveLength(0);
  });

  it('refuses a group that does not resolve, naming the role', async () => {
    const { api, pocket } = setup();
    pocket.s.missing.add('g-dev');
    const health = await api.health();
    expect(health).toMatchObject({ ok: false, layoutSuspect: false });
    expect(health.unsafe).toEqual(['group_not_found:developer']);
    await expect(api.createSignup({ kind: 'developer' }, ctx())).rejects.toThrow(
      /^IDP_UNSAFE_CONFIG/,
    );
    expect(pocket.writes()).toHaveLength(0);
  });

  it('says the layout may be wrong when every group read answers 404', async () => {
    const { api, pocket } = setup();
    for (const id of ['g-console', 'g-dev', 'g-admins', 'g-users']) pocket.s.missing.add(id);
    const health = await api.health();
    expect(health).toMatchObject({ ok: false, layoutSuspect: true });
    expect(health.unsafe).toContain('group_not_found:developer');
    expect(pocket.s.seen).toHaveLength(8);
  });

  it('reports a wrong route layout as a 404 on the group read', async () => {
    const pocket = fakePocket('admin', { now: 0 });
    const api = createApi(baseEnv('v2'), { fetch: pocket.fetch, now: () => 0 });
    const health = await api.health();
    expect(health).toMatchObject({ ok: false, layoutSuspect: true, layout: 'v2' });
  });

  it.each([
    ['env_groups', { GROUPS: '' }],
    ['env_groups', { GROUPS: '{"nope":{"id":"g","name":"passbook_x"}}' }],
    ['env_groups', { GROUPS: '[]' }],
    ['env_groups', { GROUPS: '{"console":{"id":"a b","name":"passbook_c"}}' }],
    [
      'env_groups',
      {
        GROUPS:
          '{"console":{"id":"g1","name":"passbook_c"},"developer":{"id":"g1","name":"passbook_d"}}',
      },
    ],
    [
      'env_groups',
      {
        GROUPS:
          '{"console":{"id":"g1","name":"passbook_c"},"users":{"id":"g2","name":"passbook_u"}}',
      },
    ],
    ['env_groups', { GROUPS: '{"console":{"id":"g1","name":"passbook_c","protected":true}}' }],
    ['env_group_prefix', { GROUP_PREFIX: '' }],
    ['env_group_prefix', { GROUP_PREFIX: 'other_' }],
    ['env_layout', { POCKET_ID_API: 'v3' }],
    ['env_key', { POCKET_ID_API_KEY: '' }],
    ['env_client', { PASSBOOK_CLIENT_ID: '' }],
    ['env_origin', { POCKET_ID_ORIGIN: 'http://id.test' }],
    ['env_origin', { POCKET_ID_ORIGIN: 'https://id.test/api' }],
    ['env_origin', { POCKET_ID_ORIGIN: 'https://user@id.test' }],
  ])('refuses bad settings %s without any request', async (reason, patch) => {
    const { api, pocket } = setup('v2', patch);
    expect((await api.health()).unsafe).toContain(reason);
    await expect(api.createSignup({ kind: 'member' }, ctx())).rejects.toThrow(/^IDP_UNSAFE_CONFIG/);
    expect(pocket.s.seen).toHaveLength(0);
  });

  it('refuses a writable name without the prefix, whatever the live name says', async () => {
    const groups = JSON.parse(groupsJson());
    groups.console.name = 'wallet_org_admins';
    const { api, pocket } = setup('v2', { GROUPS: JSON.stringify(groups) });
    expect((await api.health()).unsafe).toContain('env_group_prefix');
    await expect(api.apply('u1', { add: ['console'] }, ctx())).rejects.toThrow(
      /^IDP_UNSAFE_CONFIG/,
    );
    expect(pocket.s.seen).toHaveLength(0);
  });

  it('allows the protected entries to lack the prefix', async () => {
    const { api, pocket } = setup('v2', {
      GROUPS: groupsJson().replace('passbook_platform_admins', 'wallet_admins'),
    });
    pocket.s.groupNames['g-admins'] = 'wallet_admins';
    expect((await api.health()).unsafe).toEqual([]);
  });
});

describe('health cache', () => {
  it('reads Pocket ID once per ten minutes, and reports the key expiry', async () => {
    const { api, pocket, clock } = setup();
    const first = await api.health();
    expect(first).toMatchObject({
      ok: true,
      mode: 'live',
      frozen: false,
      warnings: [],
      groups: { developer: 'passbook_developers', console: 'passbook_console' },
    });
    expect(first.keyExpiresAt).toBe(Date.parse('2027-02-20T00:00:00Z'));
    const reads = pocket.s.seen.length;
    expect(reads).toBe(8);
    await api.createSignup({ kind: 'developer' }, ctx());
    await api.health();
    expect(pocket.s.seen.filter((s) => s.method === 'GET')).toHaveLength(reads);
    clock.now += 11 * 60_000;
    pocket.s.config.allowUserSignups = 'open';
    await expect(api.createSignup({ kind: 'developer' }, ctx())).rejects.toThrow(
      /^IDP_UNSAFE_CONFIG/,
    );
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
      '/api/user-groups?search=passbook_console&pagination[limit]=100',
      '/api/user-groups?search=passbook_developers&pagination[limit]=100',
      '/api/user-groups?search=passbook_platform_admins&pagination[limit]=100',
      '/api/user-groups?search=passbook_users&pagination[limit]=100',
      '/api/application-configuration/all',
      '/api/api-keys',
      '/api/users/me',
      '/api/oidc/clients/client-1',
    ]);
    await resetLedger();
    const admin = setup('admin');
    await admin.api.health();
    expect(admin.pocket.s.seen.map((s) => s.path)).toEqual([
      '/api/admin/user-groups?search=passbook_console&pagination[limit]=100',
      '/api/admin/user-groups?search=passbook_developers&pagination[limit]=100',
      '/api/admin/user-groups?search=passbook_platform_admins&pagination[limit]=100',
      '/api/admin/user-groups?search=passbook_users&pagination[limit]=100',
      '/api/admin/application-configuration',
      '/api/api-keys',
      '/api/admin/users/me',
      '/api/admin/oidc/clients/client-1',
    ]);
  });
});

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ctx, ledger, NOW, resetLedger, rows, seedGrant, setup, userCtx } from './harness.ts';

beforeEach(resetLedger);

const SUPPORT = JSON.stringify({
  console: { id: 'g-console', name: 'passbook_console' },
  developer: { id: 'g-dev', name: 'passbook_developers' },
  support: { name: 'passbook_support', friendlyName: 'PassBook support' },
  platform_admin: { id: 'g-admins', name: 'passbook_platform_admins', protected: true },
  users: { id: 'g-users', name: 'passbook_users', protected: true },
});

describe.each(['v2', 'admin'] as const)('custom groups (%s layout)', (layout) => {
  const base = layout === 'admin' ? '/api/admin' : '/api';

  it('creates passbook_g_<key>, checks the name first, reads it back and records it', async () => {
    const { api, pocket } = setup(layout);
    await expect(api.createGroup('agency_a', 'Agency A', ctx())).resolves.toEqual({
      key: 'agency_a',
    });
    const post = pocket.writes().find((w) => w.method === 'POST');
    expect(post).toMatchObject({
      path: `${base}/user-groups`,
      body: { name: 'passbook_g_agency_a', friendlyName: 'Agency A' },
    });
    const paths = pocket.s.seen.map((r) => `${r.method} ${r.path.split('?')[0]}`);
    expect(paths.indexOf(`GET ${base}/user-groups`)).toBeLessThan(
      paths.indexOf(`POST ${base}/user-groups`),
    );
    expect(await rows('idp_groups')).toMatchObject([
      {
        key: 'agency_a',
        kind: 'custom',
        state: 'live',
        group_id: 'g-new-7',
        created_by_binding: 1,
      },
    ]);
    expect((await api.groups()).find((g) => g.key === 'agency_a')).toMatchObject({
      kind: 'custom',
      name: 'passbook_g_agency_a',
      friendlyName: 'Agency A',
      members: 0,
    });
  });

  it('refuses a key that was already used', async () => {
    const { api } = setup(layout);
    await api.createGroup('agency_a', 'Agency A', ctx());
    await expect(api.createGroup('agency_a', 'Agency A', ctx({ ref: 'run-2' }))).rejects.toThrow(
      /^IDP_REFUSED/,
    );
  });

  it.each(['A', 'a', '1x', 'x'.repeat(41), 'a-b', 'console', 'support'])(
    'refuses the key %j',
    async (key) => {
      const { api, pocket } = setup(layout);
      await expect(api.createGroup(key, 'Name', ctx())).rejects.toThrow(/^IDP_REFUSED/);
      expect(pocket.s.seen).toHaveLength(0);
    },
  );

  it.each(['', 'x', 'y'.repeat(51), ' pad ', 'a\u0000b', 'é', 'line x'])(
    'refuses the friendly name %j',
    async (name) => {
      const { api, pocket } = setup(layout);
      await expect(api.createGroup('okay_key', name, ctx())).rejects.toThrow(/^IDP_REFUSED/);
      expect(pocket.s.seen).toHaveLength(0);
    },
  );

  it('stops at the group limit', async () => {
    const { api } = setup(layout, { CUSTOM_GROUP_LIMIT: '1' });
    await api.createGroup('one_group', 'One group', ctx());
    await expect(api.createGroup('two_group', 'Two group', ctx({ ref: 'r2' }))).rejects.toThrow(
      /limit/,
    );
  });

  it('names a taken name a conflict and records no group', async () => {
    const { api, pocket } = setup(layout);
    pocket.s.override = (m, p) =>
      m === 'GET' && p.includes('/user-groups?search=passbook_g_taken')
        ? { data: [{ id: 'g-x', name: 'passbook_g_taken' }], pagination: {} }
        : undefined;
    await expect(api.createGroup('taken', 'Taken', ctx())).rejects.toThrow(/^IDP_CONFLICT/);
    expect(pocket.writes()).toHaveLength(0);
    expect(await rows('idp_groups')).toEqual([]);
  });

  it('writes friendlyName only: the name goes back as read and a rename in Polaris ID blocks it', async () => {
    const { api, pocket, clock } = setup(layout);
    await api.createGroup('agency_a', 'Agency A', ctx());
    clock.now += 61_000;
    await api.updateGroup('g:agency_a', { friendlyName: 'Agency Alpha' }, ctx({ ref: 'r2' }));
    clock.now += 61_000;
    const put = pocket.writes().find((w) => w.method === 'PUT');
    expect(put).toMatchObject({
      path: `${base}/user-groups/g-new-7`,
      body: { name: 'passbook_g_agency_a', friendlyName: 'Agency Alpha' },
    });
    pocket.s.groupNames['g-new-7'] = 'renamed_by_owner';
    await expect(
      api.updateGroup('g:agency_a', { friendlyName: 'Again now' }, ctx({ ref: 'r3' })),
    ).rejects.toThrow(/^IDP_(CONFLICT|UNSAFE_CONFIG)/);
  });

  it('refuses to update or delete what it does not manage', async () => {
    const { api, pocket } = setup(layout);
    const hostile = api.updateGroup as unknown as (...a: unknown[]) => Promise<unknown>;
    for (const t of ['g-admins', 'platform_admin', 'users', 'g:nope', '', 'g:'])
      await expect(hostile(t, { friendlyName: 'Name' }, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    await expect(api.deleteGroup('console', ctx())).rejects.toThrow(/^IDP_REFUSED/);
    await expect(api.deleteGroup('unknown_key', ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('deletes only an empty, unwired group it made, once per run, and records it', async () => {
    const { api, pocket, clock } = setup(layout);
    await api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    clock.now += 61_000;
    await api.createGroup('agency_b', 'Agency B', ctx({ ref: 'mk2' }));
    pocket.addUser('u1', { groups: ['g-new-7'] });
    clock.now += 61_000;
    await expect(api.deleteGroup('agency_a', ctx({ ref: 'del' }))).rejects.toThrow(/^IDP_IN_USE/);
    pocket.s.users.get('u1')!.groups = [];
    pocket.s.meta.get('g-new-7')!.clients = ['some-app'];
    clock.now += 61_000;
    await expect(api.deleteGroup('agency_a', ctx({ ref: 'del' }))).rejects.toThrow(/^IDP_IN_USE/);
    pocket.s.meta.get('g-new-7')!.clients = [];
    clock.now += 61_000;
    await expect(api.deleteGroup('agency_a', ctx({ ref: 'del' }))).resolves.toEqual({
      key: 'agency_a',
    });
    expect(pocket.writes().some((w) => w.method === 'DELETE')).toBe(true);
    expect(await rows('idp_groups')).toMatchObject([
      { key: 'agency_a', state: 'deleted', deleted_at: expect.any(Number) },
      { key: 'agency_b' },
    ]);
    clock.now += 61_000;
    await expect(api.deleteGroup('agency_b', ctx({ ref: 'del' }))).rejects.toThrow(/^IDP_BREAKER/);
  });

  it('refuses to delete an adopted or role group', async () => {
    const { api, pocket } = setup(layout, { ADOPT_GROUPS: JSON.stringify({ staff: 'g-other' }) });
    await api.health();
    expect(await rows('idp_groups')).toMatchObject([
      { key: 'staff', kind: 'adopted', state: 'live', name: 'staff', created_by_binding: 0 },
    ]);
    await expect(api.deleteGroup('staff', ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('a group lease stops two changes to one group', async () => {
    const { api } = setup(layout);
    await api.createGroup('agency_a', 'Agency A', ctx());
    await env.DB.prepare(
      "INSERT INTO idp_locks (subject, call_id, until) VALUES ('g:agency_a', 'x', ?)",
    )
      .bind(NOW + 30_000)
      .run();
    await expect(
      api.updateGroup('g:agency_a', { friendlyName: 'Name' }, ctx({ ref: 'r2' })),
    ).rejects.toThrow(/^IDP_CONFLICT/);
  });
});

describe('pending intents', () => {
  it('a crash after the intent is settled by health: one group with the name made since is recorded, none is abandoned', async () => {
    const s = setup();
    s.pocket.s.failWith = { match: /^POST .*user-groups$/, status: 500 };
    await expect(s.api.createGroup('lost_one', 'Lost one', ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
    expect(await rows('idp_groups')).toMatchObject([
      { key: 'lost_one', state: 'pending', group_id: null },
    ]);
    s.clock.now += 11 * 60_000;
    await s.api.health();
    expect(await rows('idp_groups')).toMatchObject([{ key: 'lost_one', state: 'abandoned' }]);
    await resetLedger();
    const t = setup();
    t.pocket.s.failWith = { match: /^GET .*user-groups\/g-new/, status: 500 };
    await expect(t.api.createGroup('landed', 'Landed it', ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
    t.pocket.s.failWith = undefined;
    t.clock.now += 11 * 60_000;
    await t.api.health();
    expect(await rows('idp_groups')).toMatchObject([
      { key: 'landed', state: 'live', group_id: 'g-new-7', created_by_binding: 1 },
    ]);
  });
});

describe('role groups', () => {
  it('creates a configured role group, adds the PassBook client by union, and records it', async () => {
    const { api, pocket } = setup('v2', { GROUPS: SUPPORT });
    pocket.s.missing.add('g-support');
    expect((await api.health()).warnings).toContain('role_unplaced:support');
    await expect(api.ensureRoleGroup('support', ctx())).resolves.toEqual({ key: 'support' });
    const put = pocket.writes().find((w) => w.path.endsWith('/allowed-oidc-clients'));
    expect(put?.body).toEqual({ oidcClientIds: ['client-1'] });
    expect(await rows('idp_groups')).toMatchObject([
      { key: 'support', kind: 'role', state: 'live' },
    ]);
    pocket.addUser('u1');
    await expect(api.apply('u1', { add: ['support'] }, ctx({ ref: 'r2' }))).resolves.toMatchObject({
      added: ['support'],
    });
  });

  it('refuses a role that has an id, a conflict on the name, and a never-written role', async () => {
    const s = setup('v2', { GROUPS: SUPPORT });
    s.pocket.s.missing.add('g-support');
    await expect(s.api.ensureRoleGroup('developer', ctx())).rejects.toThrow(/^IDP_REFUSED/);
    const hostile = s.api.ensureRoleGroup as unknown as (...a: unknown[]) => Promise<unknown>;
    await expect(hostile('platform_admin', ctx())).rejects.toThrow(/^IDP_REFUSED/);
    s.pocket.s.override = (m, p) =>
      m === 'GET' && p.includes('search=passbook_support')
        ? { data: [{ id: 'x', name: 'passbook_support' }] }
        : undefined;
    await expect(s.api.ensureRoleGroup('support', ctx({ ref: 'r2' }))).rejects.toThrow(
      /^IDP_CONFLICT/,
    );
    expect(s.pocket.writes()).toHaveLength(0);
  });
});

describe('adopted groups', () => {
  it('records the name at first sight and blocks writes when the owner renames it', async () => {
    const s = setup('v2', { ADOPT_GROUPS: JSON.stringify({ staff: 'g-other' }) });
    s.pocket.addUser('u1', { groups: [] });
    await s.api.apply('u1', { add: ['g:staff'] }, ctx());
    expect(s.pocket.s.users.get('u1')?.groups).toEqual(['g-other']);
    s.pocket.s.groupNames['g-other'] = 'owner_renamed';
    s.clock.now += 11 * 60_000;
    await expect(s.api.apply('u1', { remove: ['g:staff'] }, ctx({ ref: 'r2' }))).rejects.toThrow(
      /^IDP_REFUSED/,
    );
  });

  it.each([
    ['a protected id', JSON.stringify({ staff: 'g-admins' })],
    ['a registry id', JSON.stringify({ staff: 'g-dev' })],
    ['a role key', JSON.stringify({ console: 'g-other' })],
    ['bad json', '{'],
  ])('refuses %s in ADOPT_GROUPS', async (_n, adopt) => {
    const { api, pocket } = setup('v2', { ADOPT_GROUPS: adopt });
    expect((await api.health()).unsafe).toContain('env_adopt');
    expect(pocket.s.seen).toHaveLength(0);
  });
});

describe('targets in apply', () => {
  it('adds and removes a custom group with grants by target and the group bucket', async () => {
    const { api, pocket } = setup();
    await api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    pocket.addUser('u1', { groups: ['g-extra'] });
    await api.apply(
      'u1',
      { add: ['g:agency_a', 'console'] },
      ctx({ actor: { kind: 'user', id: 'a1' } }),
    );
    expect(pocket.s.users.get('u1')?.groups).toEqual(['g-extra', 'g-new-7', 'g-console']);
    expect(await rows('idp_grants')).toMatchObject([
      { target: 'g:agency_a' },
      { target: 'console' },
    ]);
    const h = await api.health();
    expect(h.budget.apply_add_group?.day).toBe(1);
    expect(h.budget.apply_add?.day).toBe(1);
    await api.apply('u1', { remove: ['g:agency_a'] }, ctx({ ref: 'r3' }));
    expect(pocket.s.users.get('u1')?.groups).toEqual(['g-extra', 'g-console']);
  });

  it('refuses ids, names and unmanaged keys as targets, and more than ten', async () => {
    const { api, pocket } = setup();
    pocket.addUser('u1');
    const hostile = api.apply as unknown as (...a: unknown[]) => Promise<unknown>;
    for (const t of ['g-other', 'staff', 'g:Staff', 'g:nope'])
      await expect(hostile('u1', { add: [t] }, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    const many = Array.from({ length: 11 }, (_, i) => `g:k${i}x`);
    await expect(hostile('u1', { add: many }, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('lookup and snapshot cover managed groups', async () => {
    const { api, pocket } = setup();
    await api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    pocket.addUser('u1', { groups: ['g-new-7'] });
    expect((await api.lookup('u1')).roles).toEqual(['g:agency_a']);
    const snap = await api.snapshot(ctx({ ref: 'sn' }));
    expect(snap.roles['g:agency_a']?.members).toMatchObject([{ subject: 'u1' }]);
  });
});

describe('signup groups', () => {
  it('carries the groups of a spec, stores the targets, and a platform signup may carry none', async () => {
    const { api, pocket } = setup();
    await api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    await api.createSignup({ kind: 'member_developer', groups: ['agency_a'] }, ctx({ ref: 'sg' }));
    const post = pocket
      .writes()
      .filter((w) => w.method === 'POST')
      .at(-1);
    expect(post?.body).toEqual({
      ttl: '1h',
      usageLimit: 1,
      userGroupIds: ['g-dev', 'g-console', 'g-new-7'],
    });
    expect(await rows('idp_signups')).toMatchObject([
      { kind: 'member_developer', targets: '["developer","console","g:agency_a"]' },
    ]);
    expect(await api.createSignup({ kind: 'platform' }, ctx({ ref: 'bare' }))).toHaveProperty(
      'tokenId',
    );
    await expect(
      api.createSignup(
        { kind: 'platform', groups: ['a_b', 'c_d', 'e_f', 'g_h', 'i_j', 'k_l'] },
        ctx(),
      ),
    ).rejects.toThrow(/^IDP_REFUSED/);
    await expect(api.createSignup({ kind: 'platform', groups: ['nope'] }, ctx())).rejects.toThrow(
      /not managed/,
    );
  });

  it('deletes the token when Polaris ID dropped a group', async () => {
    const { api, pocket } = setup();
    await api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    pocket.s.tokenGroups = ['g-console'];
    await expect(
      api.createSignup({ kind: 'platform', groups: ['agency_a'] }, ctx()),
    ).rejects.toThrow(/^IDP_DRIFT/);
    expect(pocket.s.tokens).toHaveLength(0);
  });

  it('proves a platform account and answers match, mismatch or unverified without the address', async () => {
    const { api, pocket } = setup();
    await api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    await api.createSignup({ kind: 'platform', groups: ['agency_a'] }, ctx());
    pocket.signUp('tok-id-1', 'u-new');
    pocket.s.users.get('u-new')!.email = 'ada@example.test';
    const ok = await api.proveSignup(['tok-id-1'], { email: 'Ada@Example.test' });
    expect(ok).toMatchObject({ subject: 'u-new', emailMatch: 'match' });
    expect(JSON.stringify(ok)).not.toContain('ada@');
    expect(await rows('idp_grants')).toMatchObject([{ subject: 'u-new', target: 'g:agency_a' }]);
    expect(await api.proveSignup(['tok-id-1'], { email: 'other@example.test' })).toMatchObject({
      emailMatch: 'mismatch',
    });
    pocket.s.users.get('u-new')!.emailVerified = false;
    expect(await api.proveSignup(['tok-id-1'], { email: 'ada@example.test' })).toMatchObject({
      emailMatch: 'unverified',
    });
    expect(await ledger()).toBeDefined();
    void seedGrant;
    void userCtx;
  });
});

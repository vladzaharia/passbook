import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ctx, ledger, NOW, resetLedger, rows, seedCreated, seedGrant, setup } from './harness.ts';

beforeEach(resetLedger);

const ADOPT = JSON.stringify({ staff: 'g-other' });

describe('H2 one custom group does not stop every write', () => {
  it('an owner-renamed adopted group blocks only its own target', async () => {
    const s = setup('v2', { ADOPT_GROUPS: ADOPT });
    s.pocket.addUser('u1', { groups: ['g-dev', 'g-other'] });
    await seedGrant('u1', 'developer');
    await s.api.health();
    s.pocket.s.groupNames['g-other'] = 'owner_renamed';
    s.clock.now += 11 * 60_000;
    const h = await s.api.health();
    expect(h).toMatchObject({ ok: true, unsafe: [], blocked: ['g:staff'] });
    await expect(s.api.apply('u1', { remove: ['developer'] }, ctx())).resolves.toMatchObject({
      removed: ['developer'],
    });
    await expect(s.api.apply('u1', { add: ['g:staff'] }, ctx({ ref: 'r2' }))).rejects.toThrow(
      /^IDP_REFUSED/,
    );
  });

  it('a custom group missing once is blocked for that probe only; a second miss a TTL later makes it gone', async () => {
    const s = setup();
    await s.api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    s.pocket.addUser('u1', { groups: ['g-dev'] });
    await seedGrant('u1', 'developer');
    s.pocket.s.missing.add('g-new-7');
    s.clock.now += 11 * 60_000;
    expect(await s.api.health()).toMatchObject({ ok: true, unsafe: [], blocked: ['g:agency_a'] });
    expect(await rows('idp_groups')).toMatchObject([
      { state: 'live', missing_since: expect.any(Number) },
    ]);
    await expect(s.api.apply('u1', { remove: ['developer'] }, ctx())).resolves.toMatchObject({
      removed: ['developer'],
    });
    s.clock.now += 11 * 60_000;
    await s.api.health();
    expect(await rows('idp_groups')).toMatchObject([{ key: 'agency_a', state: 'gone' }]);
    // found again under the same id: live again
    s.pocket.s.missing.delete('g-new-7');
    s.clock.now += 11 * 60_000;
    expect((await s.api.health()).blocked).toEqual([]);
    expect(await rows('idp_groups')).toMatchObject([{ state: 'live', missing_since: null }]);
    await expect(s.api.createGroup('agency_a', 'Agency A', ctx({ ref: 'r3' }))).rejects.toThrow(
      /^IDP_REFUSED/,
    );
  });

  it('N18 a transient miss that is found next time leaves the group live and clears the mark', async () => {
    const s = setup();
    await s.api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    s.pocket.s.missing.add('g-new-7');
    s.clock.now += 11 * 60_000;
    await s.api.health();
    s.pocket.s.missing.delete('g-new-7');
    s.clock.now += 11 * 60_000;
    expect((await s.api.health()).blocked).toEqual([]);
    expect(await rows('idp_groups')).toMatchObject([{ state: 'live', missing_since: null }]);
  });

  it('N18 a wrong layout changes no custom group', async () => {
    const s = setup();
    await s.api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    for (const id of ['g-console', 'g-dev', 'g-admins', 'g-users', 'g-new-7'])
      s.pocket.s.missing.add(id);
    s.clock.now += 11 * 60_000;
    expect(await s.api.health()).toMatchObject({ layoutSuspect: true, blocked: [] });
    s.clock.now += 11 * 60_000;
    await s.api.health();
    expect(await rows('idp_groups')).toMatchObject([{ state: 'live', missing_since: null }]);
  });

  it('N19 reads role groups through the list, and N20 pages it', async () => {
    const s = setup();
    s.pocket.s.override = (m, p) =>
      m === 'GET' && p.includes('search=passbook_console') && !p.includes('pagination[page]')
        ? {
            data: Array.from({ length: 100 }, (_, i) => ({
              id: `x${i}`,
              name: 'passbook_console',
            })),
          }
        : undefined;
    await s.api.health();
    const paths = s.pocket.s.seen.map((r) => r.path);
    expect(paths).toContain(
      '/api/user-groups?search=passbook_console&pagination[limit]=100&pagination[page]=2',
    );
    expect(paths.some((p) => /\/user-groups\/g-console$/.test(p))).toBe(false);
  });

  it('health reads no member list: the user group and adopted groups come from the list', async () => {
    const s = setup('v2', { ADOPT_GROUPS: ADOPT });
    await s.api.health();
    const byId = s.pocket.s.seen
      .filter((r) => /\/user-groups\/[^/?]+$/.test(r.path))
      .map((r) => r.path);
    expect(byId).toEqual([]);
  });
});

describe('N3 to N5', () => {
  it('N3 group claims take passbook_ keys only', async () => {
    const s = setup('v2', { CLAIM_KEYS: '["tier"]' });
    await expect(
      s.api.setClaims({ group: 'developer' }, { tier: { type: 'text', value: 'x' } }, ctx()),
    ).rejects.toThrow(/^IDP_REFUSED/);
    await expect(
      s.api.setClaims(
        { group: 'developer' },
        { passbook_a: { type: 'text', value: 'x' } },
        ctx({ ref: 'r2' }),
      ),
    ).resolves.toMatchObject({ set: ['passbook_a'] });
  });

  it.each([
    ['equals GROUP_PREFIX', { CUSTOM_GROUP_PREFIX: 'passbook_' }],
    ['is the start of a role name', { CUSTOM_GROUP_PREFIX: 'passbook_con' }],
    ['is outside GROUP_PREFIX', { CUSTOM_GROUP_PREFIX: 'other_g_' }],
  ])('N4 refuses a CUSTOM_GROUP_PREFIX that %s', async (_n, patch) => {
    const { api } = setup('v2', patch);
    expect((await api.health()).unsafe).toContain('env_custom_prefix');
  });

  it('N4 refuses a key that reads as an admin group', async () => {
    const { api, pocket } = setup();
    await expect(api.createGroup('super_admins', 'Super', ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.s.seen).toHaveLength(0);
  });

  it.each([
    ['inside the namespace', 'passbook_staff_x'],
    ['an admin name', 'staff_admins'],
    ['a registry name', 'passbook_developers'],
  ])('N5 never records an adopted group whose name is %s', async (_n, name) => {
    const s = setup('v2', { ADOPT_GROUPS: ADOPT });
    s.pocket.s.groupNames['g-other'] = name;
    s.pocket.addUser('u1', { groups: [] });
    expect((await s.api.health()).blocked).toEqual(['g:staff']);
    expect(await rows('idp_groups')).toEqual([]);
    await expect(s.api.apply('u1', { add: ['g:staff'] }, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(s.pocket.writes()).toHaveLength(0);
  });
});

describe('N6 intents', () => {
  it('a definite POST failure abandons the intent at once', async () => {
    const s = setup();
    s.pocket.s.failWith = { match: /^POST .*user-groups$/, status: 409 };
    await expect(s.api.createGroup('agency_a', 'Agency A', ctx())).rejects.toThrow(/^IDP_CONFLICT/);
    expect(await rows('idp_groups')).toMatchObject([{ key: 'agency_a', state: 'abandoned' }]);
  });

  it('an unknown POST failure stays pending, and health records only a matching, empty, new group', async () => {
    const s = setup();
    s.pocket.s.failWith = { match: /^POST .*user-groups$/, status: 500 };
    await expect(s.api.createGroup('agency_a', 'Agency A', ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
    s.pocket.s.failWith = undefined;
    // the same name, but another friendly name: not the binding's
    s.pocket.addGroup('g-theirs', 'passbook_g_agency_a', 'Something else');
    s.clock.now += 11 * 60_000;
    await s.api.health();
    expect(await rows('idp_groups')).toMatchObject([{ state: 'abandoned' }]);
  });

  it('a group made long before the intent is not recorded', async () => {
    const s = setup();
    s.pocket.s.failWith = { match: /^POST .*user-groups$/, status: 500 };
    await expect(s.api.createGroup('agency_a', 'Agency A', ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
    s.pocket.s.failWith = undefined;
    s.pocket.addGroup('g-old', 'passbook_g_agency_a', 'Agency A', NOW - 3_600_000);
    s.clock.now += 11 * 60_000;
    await s.api.health();
    expect(await rows('idp_groups')).toMatchObject([{ state: 'abandoned' }]);
  });
});

describe('N7 delete', () => {
  it('stops adds before it looks, and a group in use is live again', async () => {
    const s = setup();
    await s.api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    s.pocket.addUser('u1', { groups: [] });
    s.pocket.addUser('u2', { groups: ['g-new-7'] });
    s.clock.now += 61_000;
    let during: unknown;
    s.pocket.s.hook = async (method, path) => {
      if (method === 'GET' && path.endsWith('/g-new-7') && !during) {
        during = await s.api
          .apply('u1', { add: ['g:agency_a'] }, ctx({ ref: 'r2' }))
          .catch((e) => e);
      }
    };
    await expect(s.api.deleteGroup('agency_a', ctx({ ref: 'del' }))).rejects.toThrow(/^IDP_IN_USE/);
    expect(String(during)).toMatch(/IDP_REFUSED/);
    expect(await rows('idp_groups')).toMatchObject([{ key: 'agency_a', state: 'live' }]);
  });

  it('a delete that stopped after the DELETE can be retried from deleting', async () => {
    const s = setup();
    await s.api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    s.clock.now += 61_000;
    s.pocket.s.failWith = { match: /^DELETE /, status: 500 };
    await expect(s.api.deleteGroup('agency_a', ctx({ ref: 'del' }))).rejects.toThrow(
      /^IDP_UPSTREAM/,
    );
    expect(await rows('idp_groups')).toMatchObject([{ state: 'deleting' }]);
    s.pocket.s.failWith = undefined;
    s.clock.now += 61_000;
    await expect(s.api.deleteGroup('agency_a', ctx({ ref: 'del2' }))).resolves.toEqual({
      key: 'agency_a',
    });
    expect(await rows('idp_groups')).toMatchObject([{ state: 'deleted' }]);
  });
});

describe('lows', () => {
  it('N8 keeps an unmanaged claim whose key is an Object.prototype name', async () => {
    const s = setup();
    s.pocket.addUser('u1', { groups: ['g-dev'] });
    await seedCreated('u1');
    s.pocket.s.users.get('u1')!.claims = [{ key: 'constructor', value: 'x' }];
    await s.api.setClaims({ subject: 'u1' }, { passbook_a: { type: 'text', value: 'y' } }, ctx());
    expect(s.pocket.s.users.get('u1')?.claims).toEqual([
      { key: 'constructor', value: 'x' },
      { key: 'passbook_a', value: 'y' },
    ]);
  });

  it('N9 a freeze before the write ends the pending grant', async () => {
    const s = setup();
    s.pocket.addUser('u1');
    s.pocket.s.hook = async (method, path) => {
      if (method === 'GET' && path.endsWith('/users/u1/groups')) {
        s.pocket.s.hook = undefined;
        await s.api.freeze('incident', ctx({ ref: 'f1', actor: { kind: 'user', id: 'a1' } }));
      }
    };
    await expect(s.api.apply('u1', { add: ['developer'] }, ctx())).rejects.toThrow(/^IDP_FROZEN/);
    expect(await rows('idp_grants')).toMatchObject([{ removed_reason: 'write_failed' }]);
  });

  it('N10 counts claim sizes in bytes and checks size before depth', async () => {
    const s = setup();
    s.pocket.addUser('u1', { groups: ['g-dev'] });
    await seedCreated('u1');
    await expect(
      s.api.setClaims(
        { subject: 'u1' },
        { passbook_a: { type: 'text', value: 'é'.repeat(1100) } },
        ctx(),
      ),
    ).rejects.toThrow(/^IDP_REFUSED/);
    const wide = Array.from({ length: 5000 }, (_, i) => ({ i }));
    await expect(
      s.api.setClaims(
        { subject: 'u1' },
        { passbook_a: { type: 'json', value: wide } },
        ctx({ ref: 'r2' }),
      ),
    ).rejects.toThrow(/^IDP_REFUSED/);
    await expect(
      s.api.setClaims(
        { subject: 'u1' },
        { passbook_a: { type: 'text', value: 'é'.repeat(1000) } },
        ctx({ ref: 'r3' }),
      ),
    ).resolves.toMatchObject({ set: ['passbook_a'] });
  });

  it('N11 leases are prefixed: a bare subject id does not block an account', async () => {
    const s = setup();
    s.pocket.addUser('u1');
    await env.DB.prepare("INSERT INTO idp_locks (subject, call_id, until) VALUES ('u1', 'x', ?)")
      .bind(NOW + 30_000)
      .run();
    await expect(s.api.apply('u1', { add: ['developer'] }, ctx())).resolves.toMatchObject({
      added: ['developer'],
    });
  });

  it('N12 lists only the claim keys it may manage', async () => {
    const s = setup();
    s.pocket.s.meta.set('g-dev', {
      friendly: 'Dev',
      createdAt: 0,
      claims: [
        { key: 'other_app', value: '1' },
        { key: 'passbook_a', value: '1' },
      ],
      clients: [],
    });
    const dev = (await s.api.groups()).find((g) => g.key === 'developer');
    expect(dev?.claims).toEqual(['passbook_a']);
  });

  it('N13 fails closed on a group with a malformed client entry', async () => {
    const s = setup();
    s.pocket.s.override = (m, p) =>
      m === 'GET' && p.endsWith('/g-dev')
        ? {
            id: 'g-dev',
            name: 'passbook_developers',
            friendlyName: 'Dev',
            users: [],
            customClaims: [],
            allowedOidcClients: [{}],
          }
        : undefined;
    await expect(s.api.groups()).rejects.toThrow(/^IDP_UPSTREAM/);
  });

  it("N14 treats a custom group as the binding's own but an adopted one as not", async () => {
    const s = setup('v2', { ADOPT_GROUPS: ADOPT });
    await s.api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    s.pocket.addUser('c1', { groups: ['g-dev', 'g-new-7'] });
    s.pocket.addUser('c2', { groups: ['g-dev', 'g-other'] });
    await seedCreated('c1');
    await seedCreated('c2');
    await expect(s.api.setDisabled('c1', true, ctx())).resolves.toMatchObject({
      result: 'disabled',
    });
    await expect(s.api.setDisabled('c2', true, ctx({ ref: 'r2' }))).rejects.toThrow(
      /^IDP_NOT_MANAGED/,
    );
  });

  it('N17 lets a snapshot read 60 groups in a minute', async () => {
    const { LIMITS } = await import('../../workers/polaris-binding/src/ledger.ts');
    expect(LIMITS.snapshot_group.perMinute).toBeGreaterThanOrEqual(120);
    expect((await ledger()).length).toBe(0);
  });
});

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { PolarisBinding } from '../../workers/passbook-id-connector/src/index.ts';
import { pocketRequest } from '../../workers/passbook-id-connector/src/pocket-http.ts';
import { parseRegistry } from '../../workers/passbook-id-connector/src/registry.ts';
import { IDP_CODES } from '../../workers/passbook-id-connector/src/types.ts';
import {
  baseEnv,
  captureLogs,
  ctx,
  groupsJson,
  ledger,
  NOW,
  resetLedger,
  rows,
  seedCreated,
  seedGrant,
  setup,
  userCtx,
} from './harness.ts';

beforeEach(resetLedger);

const WRANGLER = import.meta.glob('../../workers/passbook-id-connector/wrangler.jsonc', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('H1 per-subject lease', () => {
  it('answers IDP_CONFLICT while another change holds the account, with no write', async () => {
    const { api, pocket } = setup();
    pocket.addUser('u1');
    await env.DB.prepare("INSERT INTO idp_locks (subject, call_id, until) VALUES ('s:u1', 'x', ?)")
      .bind(NOW + 30_000)
      .run();
    await expect(api.apply('u1', { add: ['developer'] }, ctx())).rejects.toThrow(/^IDP_CONFLICT/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('takes over an expired lease and releases its own', async () => {
    const { api, pocket } = setup();
    pocket.addUser('u1');
    await env.DB.prepare("INSERT INTO idp_locks (subject, call_id, until) VALUES ('s:u1', 'x', ?)")
      .bind(NOW - 1)
      .run();
    await api.apply('u1', { add: ['developer'] }, ctx());
    expect(await rows('idp_locks')).toEqual([]);
  });

  it('refuses a second apply that starts while the first is between its read and its write', async () => {
    const { api, pocket } = setup();
    pocket.addUser('u1');
    let second: Promise<unknown> | undefined;
    pocket.s.hook = async (method, path) => {
      if (method === 'GET' && path.endsWith('/users/u1') && !second) {
        second = api.apply('u1', { add: ['console'] }, ctx({ ref: 'run-2' })).catch((e) => e);
        await second;
      }
    };
    await api.apply('u1', { add: ['developer'] }, ctx());
    expect(String(await second)).toMatch(/^IdpError: IDP_CONFLICT/);
    expect(pocket.s.users.get('u1')?.groups).toEqual(['g-other', 'g-dev']);
    expect(await rows('idp_locks')).toEqual([]);
  });

  it('also guards setDisabled and releases after a failure', async () => {
    const { api, pocket } = setup();
    pocket.addUser('c1', { groups: ['g-dev'] });
    await seedCreated('c1');
    pocket.s.failWith = { match: /^PUT /, status: 500 };
    await expect(api.setDisabled('c1', true, ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
    expect(await rows('idp_locks')).toEqual([]);
    await env.DB.prepare("INSERT INTO idp_locks (subject, call_id, until) VALUES ('s:c1', 'x', ?)")
      .bind(NOW + 30_000)
      .run();
    pocket.s.failWith = undefined;
    await expect(api.setDisabled('c1', true, ctx())).rejects.toThrow(/^IDP_CONFLICT/);
  });

  it('a snapshot between the pending grant and the write never ends it', async () => {
    const { api, pocket, clock } = setup();
    pocket.addUser('u1');
    let seenPending: unknown;
    let ended: unknown;
    pocket.s.hook = async (method, path) => {
      if (method !== 'PUT' || !path.endsWith('/user-groups')) return;
      seenPending = (await rows('idp_grants'))[0];
      clock.now += 1;
      ended = (await api.snapshot(ctx({ ref: 'snap-1' }))).ended;
    };
    await api.apply('u1', { add: ['developer'] }, ctx());
    expect(seenPending).toMatchObject({ confirmed_at: null, removed_at: null });
    expect(ended).toEqual([]);
    expect(await rows('idp_grants')).toMatchObject([
      { confirmed_at: expect.any(Number), removed_at: null },
    ]);
  });
});

describe('M1 two-phase grants', () => {
  it('ends a pending grant after a definite refusal, and keeps it after an unknown failure', async () => {
    const { api, pocket } = setup();
    pocket.addUser('u1');
    pocket.addUser('u2');
    pocket.s.failWith = { match: /^PUT .*u1\/user-groups/, status: 409 };
    await expect(api.apply('u1', { add: ['developer'] }, ctx())).rejects.toThrow(/^IDP_CONFLICT/);
    pocket.s.failWith = { match: /^PUT .*u2\/user-groups/, status: 500 };
    await expect(api.apply('u2', { add: ['developer'] }, ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
    expect(await rows('idp_grants')).toMatchObject([
      { subject: 'u1', removed_reason: 'write_failed' },
      { subject: 'u2', confirmed_at: null, removed_at: null },
    ]);
  });
});

describe('M2 snapshot and dry run', () => {
  it('in a dry run reports what it would end and changes nothing', async () => {
    const { api, pocket } = setup();
    pocket.addUser('u1', { groups: [] });
    pocket.addUser('x1', { groups: ['g-dev'] });
    await seedGrant('u1');
    const snap = await api.snapshot(ctx({ dryRun: true }));
    expect(snap.ended).toEqual([{ subject: 'u1', role: 'developer' }]);
    expect((await rows('idp_grants'))[0]?.removed_at).toBeNull();
    expect(await rows('idp_subjects')).toMatchObject([{ subject: 'u1', class: 'linked' }]);
  });

  it('lets a later call derive what an earlier snapshot ended', async () => {
    const { api, pocket, clock } = setup();
    pocket.addUser('u1', { groups: [] });
    await seedGrant('u1');
    await api.snapshot(ctx());
    clock.now += 61_000;
    const again = await api.snapshot({ ...ctx({ ref: 'run-2' }), since: NOW });
    expect(again.ended).toEqual([{ subject: 'u1', role: 'developer' }]);
    clock.now += 61_000;
    expect((await api.snapshot(ctx({ ref: 'run-3' }))).ended).toEqual([]);
  });

  it('does not read the user group, so a large one costs nothing', async () => {
    const { api, pocket } = setup();
    await api.snapshot(ctx());
    expect(pocket.s.seen.some((r) => r.path.endsWith('/g-users'))).toBe(false);
  });
});

describe('M3 origin', () => {
  it.each(['http://id.test', 'https://user@id.test', 'https://id.test/api', 'not a url'])(
    'refuses %s on a read, with no request',
    async (origin) => {
      const calls: string[] = [];
      await expect(
        pocketRequest(
          { ...baseEnv(), POCKET_ID_ORIGIN: origin },
          {
            now: () => NOW,
            fetch: async (u) => {
              calls.push(String(u));
              return new Response('{}');
            },
          },
          'GET',
          '/api/user-groups/g1',
        ),
      ).rejects.toThrow(/^IDP_MISCONFIGURED/);
      expect(calls).toEqual([]);
    },
  );
});

describe('M4 admin group', () => {
  it('needs a platform_admin entry, and allows several for the rename window', () => {
    const none = JSON.parse(groupsJson());
    none.platform_admin = undefined;
    expect(parseRegistry({ ...baseEnv(), GROUPS: JSON.stringify(none) }).reasons).toEqual([
      'env_groups',
    ]);
    const two = JSON.parse(groupsJson());
    two.platform_admin = [
      { id: 'g-admins', name: 'passbook_platform_admins', protected: true },
      { id: 'g-old', name: 'wallet_admins', protected: true },
    ];
    const { registry, reasons } = parseRegistry({ ...baseEnv(), GROUPS: JSON.stringify(two) });
    expect(reasons).toEqual([]);
    expect(registry?.adminIds).toEqual(['g-admins', 'g-old']);
  });

  it('refuses a writable name that reads as an admin group', () => {
    const g = JSON.parse(groupsJson());
    g.console.name = 'passbook_console_admins';
    expect(parseRegistry({ ...baseEnv(), GROUPS: JSON.stringify(g) }).reasons).toContain(
      'group_admin_name',
    );
  });

  it('refuses members of every admin id but manages members of the user group', async () => {
    const two = JSON.parse(groupsJson());
    two.platform_admin = [
      { id: 'g-admins', name: 'passbook_platform_admins', protected: true },
      { id: 'g-extra', name: 'other_app', protected: true },
    ];
    const { api, pocket } = setup('v2', { GROUPS: JSON.stringify(two) });
    pocket.addUser('old', { groups: ['g-extra'] });
    pocket.addUser('holder', { groups: ['g-users'] });
    await expect(api.apply('old', { add: ['console'] }, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    await expect(api.apply('holder', { add: ['console'] }, ctx())).resolves.toMatchObject({
      added: ['console'],
    });
    expect(pocket.s.users.get('holder')?.groups).toEqual(['g-users', 'g-console']);
  });
});

describe('M5 disabled mark', () => {
  const marked = async () => {
    const s = setup();
    s.pocket.addUser('c1', { groups: ['g-dev'] });
    await seedCreated('c1');
    await env.DB.prepare('UPDATE idp_subjects SET disabled_by_binding_at = 5 WHERE subject = ?')
      .bind('c1')
      .run();
    return s;
  };
  const mark = async () => (await rows('idp_subjects'))[0]?.disabled_by_binding_at;

  it('is cleared when lookup sees the account enabled', async () => {
    const s = await marked();
    await s.api.lookup('c1');
    expect(await mark()).toBeNull();
  });
  it('is cleared when a snapshot sees the member enabled, and kept in a dry run', async () => {
    const s = await marked();
    await s.api.snapshot(ctx({ dryRun: true }));
    expect(await mark()).toBe(5);
    s.clock.now += 61_000;
    await s.api.snapshot(ctx({ ref: 'run-2' }));
    expect(await mark()).toBeNull();
  });
  it('is cleared when setDisabled finds nothing to change', async () => {
    const s = await marked();
    await expect(s.api.setDisabled('c1', false, ctx())).resolves.toMatchObject({
      result: 'already',
    });
    expect(await mark()).toBeNull();
  });
  it('stays while the account is disabled', async () => {
    const s = await marked();
    s.pocket.s.users.get('c1')!.disabled = true;
    await s.api.lookup('c1');
    expect(await mark()).toBe(5);
  });
});

describe('M6 malformed answers fail closed', () => {
  it('a groups answer with a bad entry is an upstream error and no write', async () => {
    const { api, pocket } = setup();
    pocket.addUser('u1');
    pocket.s.override = (m, p) =>
      m === 'GET' && p.endsWith('/users/u1/groups') ? [{ id: 'g-other' }, {}] : undefined;
    await expect(api.apply('u1', { add: ['developer'] }, ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
    expect(pocket.writes()).toHaveLength(0);
  });
  it('a snapshot member without an id fails the snapshot and changes nothing', async () => {
    const { api, pocket } = setup();
    pocket.addUser('u1', { groups: [] });
    await seedGrant('u1');
    pocket.s.override = (m, p) =>
      m === 'GET' && p.endsWith('/g-dev')
        ? { name: 'passbook_developers', users: [{ id: 'a b' }] }
        : undefined;
    await expect(api.snapshot(ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
    expect((await rows('idp_grants'))[0]?.removed_at).toBeNull();
  });
  it('a user list that is not a list, or holds a non-user, fails the search', async () => {
    const { api, pocket } = setup();
    pocket.s.override = (m, p) =>
      m === 'GET' && p.includes('/users?search') ? { data: 'x' } : undefined;
    await expect(api.findByVerifiedEmail('a@example.test', ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
    pocket.s.override = (m, p) =>
      m === 'GET' && p.includes('/users?search') ? { data: [null] } : undefined;
    await expect(api.findByVerifiedEmail('a@example.test', ctx({ ref: 'r2' }))).rejects.toThrow(
      /^IDP_UPSTREAM/,
    );
  });
});

describe('M7 freeze and drift storm', () => {
  it('a freeze that lands between the read and the write stops the write', async () => {
    const { api, pocket } = setup();
    pocket.addUser('u1');
    pocket.s.hook = async (method, path) => {
      if (method === 'GET' && path.endsWith('/users/u1/groups')) {
        pocket.s.hook = undefined;
        await api.freeze('incident', userCtx({ ref: 'f1' }));
      }
    };
    await expect(api.apply('u1', { add: ['developer'] }, ctx())).rejects.toThrow(/^IDP_FROZEN/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('three drifts in ten minutes freeze the binding as system:binding', async () => {
    const { api, pocket } = setup();
    for (const u of ['u1', 'u2', 'u3', 'u4']) pocket.addUser(u);
    pocket.s.putTransform = (ids) => [...ids, 'g-extra'];
    const logs = await captureLogs(async () => {
      for (const u of ['u1', 'u2', 'u3'])
        await expect(api.apply(u, { add: ['developer'] }, ctx({ ref: `r-${u}` }))).rejects.toThrow(
          /^IDP_DRIFT/,
        );
    });
    expect(logs.lines.some((l) => l.includes('binding.drift_storm'))).toBe(true);
    expect(await rows('idp_freezes')).toMatchObject([
      { reason: 'drift_storm', actor: 'system:binding' },
    ]);
    await expect(api.apply('u4', { add: ['developer'] }, ctx())).rejects.toThrow(/^IDP_FROZEN/);
  });

  it('two drifts do not freeze', async () => {
    const { api, pocket } = setup();
    for (const u of ['u1', 'u2']) pocket.addUser(u);
    pocket.s.putTransform = (ids) => [...ids, 'g-extra'];
    for (const u of ['u1', 'u2']) await api.apply(u, { add: ['developer'] }, ctx()).catch(() => {});
    expect(await rows('idp_freezes')).toEqual([]);
  });
});

describe('L items', () => {
  it('L1 a key user without an id is unsafe', async () => {
    const { api, pocket } = setup();
    pocket.s.override = (m, p) =>
      m === 'GET' && p.endsWith('/users/me') ? { name: 'x' } : undefined;
    expect((await api.health()).unsafe).toContain('key_user_unknown');
    await expect(api.createSignup({ kind: 'member' }, ctx())).rejects.toThrow(/^IDP_UNSAFE_CONFIG/);
  });

  it('L2 reads groups and the claim first, reads the user again right before the PUT, and compares every other key', async () => {
    const { api, pocket } = setup();
    pocket.addUser('c1', { groups: ['g-dev'] });
    await seedCreated('c1');
    await api.setDisabled('c1', true, ctx());
    const trail = pocket.s.seen
      .slice(pocket.s.seen.findIndex((r) => r.path.endsWith('/users/c1')))
      .map((r) => `${r.method} ${r.path.split('/').slice(-2).join('/')}`);
    expect(trail).toEqual([
      'GET users/c1',
      'GET c1/groups',
      'GET users/c1',
      'PUT users/c1',
      'GET users/c1',
    ]);
    await resetLedger();
    const s2 = setup();
    s2.pocket.addUser('c1', { groups: ['g-dev'] });
    await seedCreated('c1');
    s2.pocket.s.userDto = (dto) =>
      s2.pocket.writes().length ? { ...dto, customClaims: [{ key: 'x', value: '1' }] } : dto;
    await expect(s2.api.setDisabled('c1', true, ctx())).rejects.toThrow(/^IDP_DRIFT/);
  });

  it('L2 refuses an account that became an admin since the first read', async () => {
    const { api, pocket } = setup();
    pocket.addUser('c1', { groups: ['g-dev'] });
    await seedCreated('c1');
    let n = 0;
    pocket.s.userDto = (dto) => (++n >= 2 ? { ...dto, isAdmin: true } : dto);
    await expect(api.setDisabled('c1', true, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it.each([
    ['too long', new Date(NOW + 2 * 3_600_000).toISOString()],
    ['unparseable', 'soon'],
  ])('L3 withdraws a signup token whose expiry is %s', async (_n, expiresAt) => {
    const { api, pocket } = setup();
    pocket.s.override = (m, p) =>
      m === 'POST' && p.endsWith('/signup-tokens')
        ? {
            id: 'tok-id-9',
            token: 'SECRETTOKEN9abcdef',
            expiresAt,
            usageLimit: 1,
            userGroups: [{ id: 'g-console' }],
          }
        : undefined;
    await expect(api.createSignup({ kind: 'member' }, ctx())).rejects.toThrow(/^IDP_DRIFT/);
    expect(pocket.s.seen.some((r) => r.method === 'DELETE' && r.path.endsWith('/tok-id-9'))).toBe(
      true,
    );
    expect(await rows('idp_signups')).toEqual([]);
  });

  it('L4 answers null when the search has more pages than it reads', async () => {
    const { api, pocket } = setup();
    pocket.addUser('u1', { email: 'a@example.test' });
    pocket.s.override = (m, p) =>
      m === 'GET' && p.includes('/users?search')
        ? {
            data: [],
            pagination: { totalPages: 4, totalItems: 400, currentPage: 1, itemsPerPage: 100 },
          }
        : undefined;
    await expect(api.findByVerifiedEmail('a@example.test', ctx())).resolves.toBeNull();
  });

  it('L6 turns traces off in the binding config', () => {
    const text = Object.values(WRANGLER)[0] ?? '';
    expect(text).toMatch(/"traces":\s*\{\s*"enabled":\s*false\s*\}/);
  });

  it('L7 exposes exactly the RPC methods', async () => {
    const methods = Object.getOwnPropertyNames(PolarisBinding.prototype)
      .filter((n) => n !== 'constructor')
      .sort();
    expect(methods).toEqual(
      [
        'allowClientGroups',
        'ensureScim',
        'placeRoleGroups',
        'restrictClient',
        'setClientLogo',
        'setupStatus',
        'syncScim',
        'apply',
        'claims',
        'createGroup',
        'deleteGroup',
        'ensureRoleGroup',
        'groups',
        'setClaims',
        'updateGroup',
        'calls',
        'createSignup',
        'deleteSignup',
        'findByVerifiedEmail',
        'freeze',
        'health',
        'lookup',
        'proveSignup',
        'setDisabled',
        'snapshot',
      ].sort(),
    );
    expect(IDP_CODES).toContain('IDP_FROZEN');
  });

  it('L8 pages the ledger by id', async () => {
    const { api } = setup();
    await api.createSignup({ kind: 'member' }, ctx());
    const all = await api.calls(0);
    expect(all.length).toBeGreaterThan(2);
    const rest = await api.calls(0, all[0]?.id);
    expect(rest.map((r) => r.id)).toEqual(all.slice(1).map((r) => r.id));
  });
});

describe('coordinator decisions', () => {
  it('a caller dry run spends the preview bucket, never apply_override', async () => {
    const { api, pocket } = setup();
    pocket.addUser('u1', { groups: ['g-dev'] });
    await api.apply('u1', { remove: ['developer'] }, ctx({ override: true, dryRun: true }));
    const h = await api.health();
    expect(h.budget.preview?.day).toBe(1);
    expect(h.budget.apply_override?.day).toBe(0);
    expect((await ledger()).filter((r) => r.bucket === 'preview')).toHaveLength(1);
  });
});

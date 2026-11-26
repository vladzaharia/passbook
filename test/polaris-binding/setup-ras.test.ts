import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { callbacksOurs, parseClient } from '../../workers/polaris-binding/src/client-dto.ts';
import { parseRegistry } from '../../workers/polaris-binding/src/registry.ts';
import { routes } from '../../workers/polaris-binding/src/routes.ts';
import bindingWrangler from '../../workers/polaris-binding/wrangler.jsonc?raw';
import mainWrangler from '../../wrangler.jsonc?raw';
import { CIMD, TOKEN } from './fake-setup.ts';
import { baseEnv, groupsJson, resetLedger, rows } from './harness.ts';
import { setupCimd, setupCtx, writes } from './setup-harness.ts';

beforeEach(resetLedger);
const run = (r = 'r1', over = {}) => setupCtx({ ref: r, ...over });

type H = ReturnType<typeof setupCimd>;
/** The seven setup writes, each as a call on a fresh context. */
const SEVEN: [string, (h: H, ctx: unknown) => Promise<unknown>][] = [
  ['placeRoleGroups', (h, c) => h.api.placeRoleGroups(c as never)],
  ['allowClientGroups', (h, c) => h.api.allowClientGroups(c as never)],
  ['restrictClient', (h, c) => h.api.restrictClient(c as never)],
  ['setClientLogo', (h, c) => h.api.setClientLogo(c as never)],
  ['ensureScim', (h, c) => h.api.ensureScim(TOKEN, c as never)],
  ['syncScim', (h, c) => h.api.syncScim(c as never)],
];

describe('M1: a renamed or deleted recorded group stops every setup write', () => {
  it.each(SEVEN)('%s refuses on group_name_mismatch', async (_n, call) => {
    const h = setupCimd('v2');
    h.pocket.s.groupNames['g-admins'] = 'someone_elses_group';
    await expect(call(h, run())).rejects.toMatchObject({ code: 'IDP_UNSAFE_CONFIG' });
    expect(writes(h)).toEqual([]);
  });

  it.each(SEVEN)('%s refuses on group_not_found', async (_n, call) => {
    const h = setupCimd('v2');
    h.pocket.s.missing.add('g-admins');
    await expect(call(h, run())).rejects.toMatchObject({
      code: 'IDP_UNSAFE_CONFIG',
      message: expect.stringContaining('group_not_found:platform_admin'),
    });
    expect(writes(h)).toEqual([]);
  });

  it('other health reasons do not block setup', async () => {
    const h = setupCimd('v2');
    h.pocket.s.config.allowUserSignups = 'enabled';
    expect(await h.api.allowClientGroups(run())).toMatchObject({ result: 'already' });
  });
});

describe('M2: the seven need an explicit boolean dryRun', () => {
  it.each(SEVEN)(
    '%s refuses a missing or non-boolean dryRun before any request',
    async (_n, call) => {
      for (const bad of [undefined, 'false', 0, null]) {
        const h = setupCimd('v2');
        const { dryRun: _d, ...bare } = run();
        await expect(
          call(h, bad === undefined ? bare : { ...bare, dryRun: bad }),
        ).rejects.toMatchObject({ code: 'IDP_REFUSED' });
        expect(h.pocket.s.seen).toHaveLength(0);
      }
    },
  );

  it('a missing dryRun is not a live write in dry-run week', async () => {
    const h = setupCimd('v2', { patch: { WRITE_MODE: 'dry_run' } });
    h.pocket.s.client.allowed = [];
    const { dryRun: _d, ...bare } = run();
    await expect(h.api.allowClientGroups(bare as never)).rejects.toMatchObject({
      code: 'IDP_REFUSED',
    });
    expect(writes(h)).toEqual([]);
  });
});

describe('M3: alias groups the main Worker accepts', () => {
  const ALIAS_GROUPS = JSON.stringify({ aliases: ['staff'], ...JSON.parse(groupsJson()) });
  const withAlias = (layout: 'v2' | 'admin' = 'v2') =>
    setupCimd(layout, { patch: { GROUPS: ALIAS_GROUPS } });
  const open = (h: H) => {
    h.pocket.s.client.restricted = false;
    h.pocket.s.client.allowed = ['g-console', 'g-dev', 'g-admins', 'g-users'];
  };

  it('allowClientGroups adds an existing alias group and writes nothing else', async () => {
    const h = withAlias();
    open(h);
    expect(await h.api.allowClientGroups(run())).toEqual({
      result: 'allowed',
      added: 1,
      dryRun: false,
    });
    expect(h.pocket.s.client.allowed).toContain('g-other');
    expect(writes(h)).toHaveLength(1);
    expect(writes(h)[0]).toMatch(/^PUT .*\/allowed-user-groups$/);
  });

  it('an alias that does not exist is skipped, never created', async () => {
    const h = setupCimd('v2', {
      patch: {
        GROUPS: JSON.stringify({ aliases: ['no_such_group'], ...JSON.parse(groupsJson()) }),
      },
    });
    open(h);
    expect((await h.api.allowClientGroups(run())).result).toBe('already');
    expect(await h.api.restrictClient(run('r2'))).toEqual({ result: 'restricted', dryRun: false });
    expect(writes(h).filter((w) => w.startsWith('POST'))).toEqual([]);
  });

  it.each(['v2', 'admin'] as const)(
    'restrictClient refuses while the alias is not allowed (%s)',
    async (layout) => {
      const h = withAlias(layout);
      open(h);
      await expect(h.api.restrictClient(run())).rejects.toMatchObject({
        code: 'IDP_CLIENT',
        message: 'IDP_CLIENT: client_lockout',
      });
      expect(writes(h)).toEqual([]);
      await h.api.allowClientGroups(run('r2'));
      h.pocket.s.client.restricted = false;
      expect((await h.api.restrictClient(run('r3'))).result).toBe('restricted');
    },
  );

  it('setupStatus does not count the alias as another app group', async () => {
    const h = withAlias();
    h.pocket.s.client.allowed = [...h.pocket.s.client.allowed, 'g-other'];
    expect((await h.api.setupStatus()).client.otherGroups).toBe(0);
  });

  it('GROUPS aliases must be plain names, and not repeat a configured name', () => {
    for (const aliases of ['x', [1], ['has space'], ['passbook_console']]) {
      const { registry, reasons } = parseRegistry({
        ...baseEnv(),
        GROUPS: JSON.stringify({ aliases, ...JSON.parse(groupsJson()) }),
      });
      expect(registry).toBeNull();
      expect(reasons).toContain('env_groups');
    }
  });

  it('pins parity: every group the main Worker accepts is in the binding GROUPS or its aliases', () => {
    const vars = (raw: string): Record<string, string> =>
      JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')).vars;
    const main = vars(mainWrangler);
    const accepted = Object.entries(main)
      .filter(([k]) => /^OIDC_[A-Z_]+_GROUP$/.test(k))
      .flatMap(([, v]) => v.split(','))
      .map((n) => n.trim())
      .filter(Boolean);
    expect(accepted.length).toBeGreaterThan(4);
    const groups = JSON.parse(vars(bindingWrangler).GROUPS ?? '{}') as Record<string, unknown>;
    const known = new Set<string>();
    for (const [role, v] of Object.entries(groups)) {
      if (role === 'aliases') for (const n of v as string[]) known.add(n);
      else for (const g of Array.isArray(v) ? v : [v]) known.add((g as { name: string }).name);
    }
    expect(accepted.filter((n) => !known.has(n))).toEqual([]);
    expect(known.has('wallet_org_admins')).toBe(true);
  });
});

describe('L1: syncScim refuses an open client', () => {
  it('sends no sync after the owner unrestricts', async () => {
    const h = setupCimd('v2');
    await h.api.ensureScim(TOKEN, run());
    h.pocket.s.client.restricted = false;
    await expect(h.api.syncScim(run('r2'))).rejects.toMatchObject({
      code: 'IDP_CLIENT',
      message: 'IDP_CLIENT: client_open',
    });
    expect(writes(h).some((w) => w.includes('/sync'))).toBe(false);
  });
});

describe('L2: a SCIM provider id comes only from the client own read', () => {
  it('scim and scimSync refuse a provider not read from scimOf(client)', () => {
    const r = routes('v2');
    const stray = { id: 'sp-9', from: '/api/oidc/clients/other/scim-service-provider' };
    expect(() => r.scim(stray, CIMD)).toThrow();
    expect(() => r.scimSync(stray, CIMD)).toThrow();
    expect(() => r.scim({ id: 'sp-9' } as never, CIMD)).toThrow();
    const own = { id: 'sp-1', from: r.scimOf(CIMD) };
    expect(r.scim(own, CIMD)).toBe('/api/scim/service-provider/sp-1');
    expect(r.scimSync(own, CIMD)).toBe('/api/scim/service-provider/sp-1/sync');
  });
});

describe('L3: setup leases do not share the user key space', () => {
  it('the client and scim leases are prefixed setup:', async () => {
    const h = setupCimd('v2');
    const held: string[] = [];
    h.pocket.s.hook = async () => {
      for (const r of await rows('idp_locks')) held.push(String(r.subject));
    };
    h.pocket.s.client.allowed = [];
    await h.api.allowClientGroups(run());
    await h.api.ensureScim(TOKEN, run('r2'));
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((k) => k.startsWith('setup:'))).toBe(true);
    expect(new Set(held)).toEqual(new Set(['setup:client', 'setup:scim']));
  });
});

describe('L4: a freeze during placeRoleGroups stops the records', () => {
  it('records nothing once frozen', async () => {
    const h = setupCimd('v2', { names: true });
    let frozen = false;
    h.pocket.s.hook = async () => {
      if (frozen) return;
      frozen = true;
      await env.DB.prepare(
        "INSERT INTO idp_freezes (at, reason, actor) VALUES (1, 'x', 'o')",
      ).run();
    };
    await expect(h.api.placeRoleGroups(run())).rejects.toMatchObject({ code: 'IDP_FROZEN' });
    expect(await rows('idp_groups')).toEqual([]);
  });
});

describe('L5: callbacks that are not PassBook own', () => {
  it.each([
    ['another origin', ['https://other.test/cb']],
    ['none', []],
    ['one of two foreign', ['https://passbook.mobile/cb', 'https://other.test/cb']],
  ])('status says so and every write refuses the client (%s)', async (_n, urls) => {
    const h = setupCimd('v2');
    expect((await h.api.setupStatus()).client.callbacksOurs).toBe(true);
    h.fake.cl.fields.callbackURLs = urls;
    expect((await h.api.setupStatus()).client.callbacksOurs).toBe(false);
    for (const [name, call] of SEVEN.filter(([n]) => n !== 'placeRoleGroups')) {
      const g = setupCimd('v2');
      g.fake.cl.fields.callbackURLs = urls;
      await expect(call(g, run(name)), name).rejects.toMatchObject({
        code: 'IDP_CLIENT',
        message: 'IDP_CLIENT: client_foreign_callbacks',
      });
      expect(writes(g)).toEqual([]);
    }
  });

  it('is false for a plain registered client id', () => {
    const c = parseClient({
      id: 'plain',
      clientType: 'regular',
      isGroupRestricted: true,
      hasLogo: false,
      hasDarkLogo: false,
      allowedUserGroups: [],
      callbackURLs: ['https://passbook.mobile/cb'],
    });
    expect(callbacksOurs(c, 'plain')).toBe(false);
  });
});

describe('N1: the writes that decide sign-in read health fresh', () => {
  it.each([
    ['allowClientGroups', (h: H) => h.api.allowClientGroups(run('n1'))],
    ['restrictClient', (h: H) => h.api.restrictClient(run('n1'))],
  ])('%s refuses a rename inside the health cache window', async (_n, call) => {
    const h = setupCimd('v2');
    h.pocket.s.client.restricted = false;
    expect((await h.api.health()).ok).toBe(true);
    h.pocket.s.groupNames['g-admins'] = 'someone_elses_group';
    await expect(call(h)).rejects.toMatchObject({ code: 'IDP_UNSAFE_CONFIG' });
    expect(writes(h)).toEqual([]);
  });
});

describe('N3: an alias group is never adopted as a writable group', () => {
  it('ADOPT_GROUPS naming the alias group is refused', async () => {
    const h = setupCimd('v2', {
      patch: {
        GROUPS: JSON.stringify({ aliases: ['staff'], ...JSON.parse(groupsJson()) }),
        ADOPT_GROUPS: JSON.stringify({ crew: 'g-other' }),
      },
    });
    const health = await h.api.health();
    expect(health.warnings).toContain('blocked:g:crew');
    expect((await rows('idp_groups')).some((g) => g.key === 'crew')).toBe(false);
  });
});

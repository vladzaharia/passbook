import { beforeEach, describe, expect, it } from 'vitest';
import { pocketRequest } from '../../workers/passbook-id-connector/src/pocket-http.ts';
import { allowedRoutes, routes } from '../../workers/passbook-id-connector/src/routes.ts';
import { CIMD, ENC, TOKEN } from './fake-setup.ts';
import { baseEnv, NOW, resetLedger, rows } from './harness.ts';
import { setupCimd, setupCtx, writes } from './setup-harness.ts';

beforeEach(resetLedger);
const run = (r = 't1', over = {}) => setupCtx({ ref: r, ...over });
const SOURCES = import.meta.glob('../../workers/passbook-id-connector/src/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const source = (n: string) => SOURCES[`../../workers/passbook-id-connector/src/${n}.ts`] as string;
const SETUP = [
  'setup-status',
  'setup-groups',
  'setup-client',
  'setup-scim',
  'setup-shell',
  'client-dto',
];

describe('threat model 25 to 33 (design: automatic Polaris ID setup, section 6)', () => {
  describe('#25 a caller redirects the SCIM push', () => {
    it('no setup RPC takes an id, name, URL or endpoint', () => {
      const { api } = setupCimd();
      expect(api.placeRoleGroups.length).toBe(1);
      expect(api.allowClientGroups.length).toBe(1);
      expect(api.restrictClient.length).toBe(1);
      expect(api.setClientLogo.length).toBe(1);
      expect(api.syncScim.length).toBe(1);
      // The token is the only extra value, and it addresses nothing.
      expect(api.ensureScim.length).toBe(2);
      expect(api.setupStatus.length).toBeLessThanOrEqual(1);
    });

    it('the endpoint is derived from the client id origin, not read from any input', () => {
      expect(source('setup-scim')).toContain('passbookOrigin(env.PASSBOOK_CLIENT_ID)');
      expect(source('setup-scim')).not.toMatch(/ctx\.endpoint|token\.endpoint/);
    });

    it('a foreign endpoint is refused, never overwritten', async () => {
      const h = setupCimd();
      h.fake.sc.provider = {
        id: 'sp-1',
        endpoint: 'https://owner.test/scim/v2',
        token: TOKEN,
        lastSyncedAt: null,
      };
      await expect(h.api.ensureScim(TOKEN, run())).rejects.toMatchObject({
        code: 'IDP_SCIM_FOREIGN',
      });
      await expect(h.api.syncScim(run('t2'))).rejects.toMatchObject({ code: 'IDP_SCIM_FOREIGN' });
      expect(writes(h)).toEqual([]);
    });
  });

  describe('#26 restricting the client locks everyone out', () => {
    it('refuses unless the platform admin group is allowed, then restricts', async () => {
      const h = setupCimd();
      h.pocket.s.client.restricted = false;
      h.pocket.s.client.allowed = ['g-console'];
      await expect(h.api.restrictClient(run())).rejects.toMatchObject({
        message: 'IDP_CLIENT: client_lockout',
      });
      await h.api.allowClientGroups(run('t2'));
      expect(await h.api.restrictClient(run('t3'))).toMatchObject({ result: 'restricted' });
    });

    it('the restriction flag is only ever the literal true', () => {
      for (const n of Object.keys(SOURCES))
        expect(SOURCES[n], n).not.toMatch(/isGroupRestricted:\s*(false|!)/);
      expect(source('client-dto')).toContain('isGroupRestricted: true');
    });
  });

  describe('#27 SCIM on an unrestricted client pushes the directory', () => {
    it('ensureScim refuses client_open and creates nothing', async () => {
      const h = setupCimd();
      h.pocket.s.client.restricted = false;
      await expect(h.api.ensureScim(TOKEN, run())).rejects.toMatchObject({ code: 'IDP_CLIENT' });
      expect(h.fake.sc.provider).toBeNull();
    });
  });

  describe('#28 the wrong group is recorded as platform admins', () => {
    it('records the exact name only, not a longer name that contains it', async () => {
      const h = setupCimd('v2', { names: true });
      h.pocket.addGroup('g-near', 'wallet_admins_old');
      h.pocket.addGroup('g-wa', 'wallet_admins');
      await h.api.placeRoleGroups(run());
      const keys = (await rows('idp_groups')).map((g) => `${g.key}=${g.group_id}`);
      expect(keys).toContain('platform_admin:wallet_admins=g-wa');
      expect(keys.some((k) => k.includes('g-near'))).toBe(false);
    });

    it('a later rename of the recorded group blocks every write', async () => {
      const h = setupCimd('v2', { names: true });
      await h.api.placeRoleGroups(run());
      expect((await h.api.health()).unsafe).toEqual([]);
      h.clock.now += 11 * 60_000;
      h.pocket.s.groupNames['g-admins'] = 'renamed_admins';
      await expect(h.api.createSignup({ kind: 'member' }, run('t2'))).rejects.toMatchObject({
        code: 'IDP_UNSAFE_CONFIG',
      });
    });
  });

  describe('#29 adopting a writable group another app trusts', () => {
    it('refuses another client, a foreign claim and an LDAP group', async () => {
      for (const patch of [
        { allowedOidcClients: [{ id: 'other-app' }] },
        { customClaims: [{ key: 'plan', value: 'x' }] },
        { ldapId: 'cn=dev' },
      ]) {
        const h = setupCimd('v2', { names: true });
        h.pocket.s.override = (m, p) =>
          m === 'GET' && p.endsWith('/user-groups/g-dev')
            ? {
                id: 'g-dev',
                name: 'passbook_developers',
                friendlyName: 'd',
                users: [],
                customClaims: [],
                allowedOidcClients: [],
                ...patch,
              }
            : undefined;
        expect((await h.api.placeRoleGroups(run())).roles.developer).toBe('in_use');
        expect(writes(h)).toEqual([]);
        await resetLedger();
      }
    });
  });

  describe('#30 the echo PUT loses a concurrent owner edit', () => {
    it('reads fresh each call, compares every field back, and three drifts freeze changes', async () => {
      const h = setupCimd();
      let n = 0;
      h.fake.cl.transform = (b) => ({ ...b, description: `owner edit ${n++}` });
      for (const r of ['d1', 'd2', 'd3']) {
        h.pocket.s.client.restricted = false;
        h.pocket.s.client.allowed = ['g-admins'];
        await expect(h.api.restrictClient(run(r))).rejects.toMatchObject({ code: 'IDP_DRIFT' });
      }
      h.pocket.s.client.restricted = false;
      await expect(h.api.restrictClient(run('d4'))).rejects.toMatchObject({ code: 'IDP_FROZEN' });
    });
  });

  describe('#31 ~ decoding turns a segment into me or another id', () => {
    it('allows ~ only in the configured client literal, in every setup route', () => {
      for (const layout of ['v2', 'admin'] as const) {
        const base = layout === 'admin' ? '/api/admin' : '/api';
        const table = allowedRoutes(layout, CIMD);
        const hit = (m: string, p: string) => table.some((t) => t.method === m && t.path.test(p));
        expect(hit('PUT', `${base}/oidc/clients/${ENC}/allowed-user-groups`)).toBe(true);
        for (const [m, p] of [
          ['PUT', `${base}/oidc/clients/~bWU`],
          ['PUT', `${base}/oidc/clients/~bWU/allowed-user-groups`],
          ['GET', `${base}/oidc/clients/~bWU/scim-service-provider`],
          ['PUT', `${base}/scim/service-provider/~bWU`],
          ['POST', `${base}/scim/service-provider/~bWU/sync`],
          ['PUT', `${base}/scim/service-provider/${ENC}`],
        ] as const)
          expect(hit(m, p), `${m} ${p}`).toBe(false);
        const r = routes(layout);
        expect(() => r.scim({ id: '~bWU', from: r.scimOf(CIMD) }, CIMD)).toThrow();
        expect(() => r.scimSync({ id: '~bWU', from: r.scimOf(CIMD) }, CIMD)).toThrow();
      }
    });

    it('a provider id Polaris ID answers with a ~ is not used', async () => {
      const h = setupCimd();
      h.pocket.s.override = (m, p) =>
        m === 'GET' && p.endsWith('/scim-service-provider')
          ? {
              id: '~bWU',
              endpoint: 'https://passbook.mobile/scim/v2',
              token: TOKEN,
              lastSyncedAt: null,
            }
          : undefined;
      await expect(h.api.syncScim(run())).rejects.toMatchObject({ code: 'IDP_UPSTREAM' });
      expect(writes(h)).toEqual([]);
    });

    it('pocketRequest refuses the setup routes of another client', async () => {
      const env = { ...baseEnv(), PASSBOOK_CLIENT_ID: CIMD };
      const d = { fetch: async () => new Response('{}'), now: () => NOW };
      await expect(pocketRequest(env, d, 'PUT', '/api/oidc/clients/~bWU')).rejects.toThrow(
        /^IDP_MISCONFIGURED/,
      );
      await expect(
        pocketRequest(env, d, 'DELETE', `/api/scim/service-provider/sp-1`),
      ).rejects.toThrow(/^IDP_MISCONFIGURED/);
      await expect(pocketRequest(env, d, 'DELETE', `/api/oidc/clients/${ENC}`)).rejects.toThrow(
        /^IDP_MISCONFIGURED/,
      );
    });
  });

  describe('#32 the SCIM token leaks', () => {
    it('is never stored: no table, no source line that persists it', async () => {
      const h = setupCimd();
      await h.api.ensureScim(TOKEN, run());
      const tables = ['idp_calls', 'idp_groups', 'idp_health', 'idp_locks'];
      for (const t of tables) expect(JSON.stringify(await rows(t)), t).not.toContain(TOKEN);
      expect(source('setup-scim')).not.toMatch(/console\.|alert\(/);
    });

    it('drops the clear token Polaris ID returns', async () => {
      const h = setupCimd();
      await h.api.ensureScim(TOKEN, run());
      const out = await h.api.setupStatus({ tokenHashes: [] });
      expect(JSON.stringify(out)).not.toContain(TOKEN);
    });
  });

  describe('#33 setup writes go live during the dry run', () => {
    it('the seven act on a caller dryRun and the freeze, not WRITE_MODE; membership stays dry', async () => {
      const h = setupCimd('v2', { names: true, patch: { WRITE_MODE: 'dry_run' } });
      h.pocket.s.missing.add('g-console');
      await h.api.placeRoleGroups(run('a'));
      h.pocket.s.client.restricted = false;
      h.pocket.s.client.allowed = [];
      expect((await h.api.allowClientGroups(run('b'))).dryRun).toBe(false);
      expect((await h.api.restrictClient(run('c'))).dryRun).toBe(false);
      expect((await h.api.setClientLogo(run('d'))).dryRun).toBe(false);
      expect((await h.api.ensureScim(TOKEN, run('e'))).dryRun).toBe(false);
      expect((await h.api.syncScim(run('f'))).dryRun).toBe(false);
      expect(writes(h).length).toBeGreaterThanOrEqual(6);
      // A membership write is still only computed.
      expect(await h.api.createSignup({ kind: 'member' }, run('g'))).toEqual({ dryRun: true });
    });

    it('a caller dry run sends no write from any of the seven', async () => {
      const h = setupCimd('v2', { names: true });
      h.pocket.s.missing.add('g-console');
      h.pocket.s.client.restricted = false;
      const dry = { dryRun: true };
      await h.api.placeRoleGroups(run('a', dry));
      await h.api.allowClientGroups(run('b', dry)).catch(() => undefined);
      await h.api.restrictClient(run('c', dry)).catch(() => undefined);
      await h.api.setClientLogo(run('d', dry)).catch(() => undefined);
      await h.api.ensureScim(TOKEN, run('e', dry)).catch(() => undefined);
      await h.api.syncScim(run('f', dry)).catch(() => undefined);
      expect(writes(h)).toEqual([]);
    });

    it('sends only through pocketRequest, never fetch', () => {
      for (const f of SETUP) expect(source(f), f).not.toMatch(/\bfetch\(|deps\.fetch/);
    });
  });
});

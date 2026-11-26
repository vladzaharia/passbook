import { beforeEach, describe, expect, it } from 'vitest';
import { ledger, resetLedger, rows } from './harness.ts';
import { setupCimd, setupCtx, writes } from './setup-harness.ts';

beforeEach(resetLedger);
const run = (r = 'c1', over = {}) => setupCtx({ ref: r, ...over });
const base = (layout: string) => (layout === 'admin' ? '/api/admin' : '/api');
const bodies = (h: ReturnType<typeof setupCimd>, method: string) =>
  h.pocket.s.seen.filter((r) => r.method === method).map((r) => r.body as Record<string, unknown>);

describe.each(['v2', 'admin'] as const)('client writes (%s layout)', (layout) => {
  describe('allowClientGroups', () => {
    it('adds the placed registry groups and keeps what the owner allowed', async () => {
      const h = setupCimd(layout);
      h.pocket.s.client.allowed = ['g-console', 'g-extra'];
      const res = await h.api.allowClientGroups(run());
      expect(res).toEqual({ result: 'allowed', added: 3, dryRun: false });
      expect(new Set(h.pocket.s.client.allowed)).toEqual(
        new Set(['g-console', 'g-extra', 'g-dev', 'g-admins', 'g-users']),
      );
      expect(writes(h)).toHaveLength(1);
      expect(writes(h)[0]).toMatch(/^PUT .*\/allowed-user-groups$/);
    });

    it('never removes a group: the sent set is a superset of the live one', async () => {
      const h = setupCimd(layout);
      h.pocket.s.client.allowed = ['g-extra', 'g-other', 'g-console'];
      await h.api.allowClientGroups(run());
      const sent = (bodies(h, 'PUT')[0] as { userGroupIds: string[] }).userGroupIds;
      for (const id of ['g-extra', 'g-other', 'g-console']) expect(sent).toContain(id);
    });

    it('is already when the client allows every registry group', async () => {
      const h = setupCimd(layout);
      expect(await h.api.allowClientGroups(run())).toEqual({
        result: 'already',
        added: 0,
        dryRun: false,
      });
      expect(writes(h)).toEqual([]);
    });

    it('sends nothing on a dry run', async () => {
      const h = setupCimd(layout);
      h.pocket.s.client.allowed = [];
      const res = await h.api.allowClientGroups({ ...run(), dryRun: true });
      expect(res).toEqual({ result: 'allowed', added: 4, dryRun: true });
      expect(writes(h)).toEqual([]);
      expect(h.pocket.s.client.allowed).toEqual([]);
      expect(
        (await ledger()).some((r) => r.phase === 'dry_run' && r.method === 'allowClientGroups'),
      ).toBe(true);
    });

    it('refuses while a role is unplaced', async () => {
      const h = setupCimd(layout, { names: true });
      await expect(h.api.allowClientGroups(run())).rejects.toMatchObject({ code: 'IDP_REFUSED' });
      expect(h.pocket.s.seen).toHaveLength(0);
    });

    it('refuses a client that is not found or not ours', async () => {
      const h = setupCimd(layout);
      h.fake.cl.found = false;
      await expect(h.api.allowClientGroups(run())).rejects.toMatchObject({ code: 'IDP_CLIENT' });
      const g = setupCimd(layout);
      g.pocket.s.override = (m, p) =>
        m === 'GET' && p.includes('/oidc/clients/')
          ? {
              id: 'someone-else',
              clientType: 'cimd',
              isGroupRestricted: true,
              hasLogo: false,
              hasDarkLogo: false,
              allowedUserGroups: [],
            }
          : undefined;
      await expect(g.api.allowClientGroups(run())).rejects.toMatchObject({ code: 'IDP_CLIENT' });
      expect(writes(g)).toEqual([]);
    });

    it('is IDP_DRIFT when the groups do not come back as written', async () => {
      const h = setupCimd(layout);
      h.pocket.s.client.allowed = [];
      h.fake.cl.allowedTransform = (ids) => ids.slice(1);
      await expect(h.api.allowClientGroups(run())).rejects.toMatchObject({ code: 'IDP_DRIFT' });
    });

    it('stops when frozen and when over the client_write budget', async () => {
      const h = setupCimd(layout);
      h.pocket.s.client.allowed = [];
      for (const [i, id] of ['g-console', 'g-dev', 'g-admins'].entries()) {
        h.pocket.s.client.allowed = [id];
        await h.api.allowClientGroups(run(`b${i}`));
        h.pocket.s.client.allowed = [id];
      }
      await expect(h.api.allowClientGroups(run('b9'))).rejects.toMatchObject({
        code: 'IDP_BUDGET',
      });
      const f = setupCimd(layout);
      await f.api.freeze('check', run('f'));
      await expect(f.api.allowClientGroups(run())).rejects.toMatchObject({ code: 'IDP_FROZEN' });
    });
  });

  describe('restrictClient', () => {
    const open = (h: ReturnType<typeof setupCimd>) => {
      h.pocket.s.client.restricted = false;
    };

    it('sends the full DTO echoed from the read plus isGroupRestricted true', async () => {
      const h = setupCimd(layout);
      open(h);
      h.pocket.s.client.allowed = ['g-console', 'g-dev', 'g-admins', 'g-users'];
      const res = await h.api.restrictClient(run());
      expect(res).toEqual({ result: 'restricted', dryRun: false });
      const [body] = bodies(h, 'PUT');
      expect(body).toMatchObject({
        name: 'PassBook',
        callbackURLs: ['https://passbook.mobile/auth/oidc/callback'],
        isPublic: true,
        pkceEnabled: true,
        isGroupRestricted: true,
        accessTokenDurationMinutes: 60,
      });
      expect(Object.keys(body ?? {})).toHaveLength(19);
      expect(h.pocket.s.client.restricted).toBe(true);
      expect(h.pocket.s.client.allowed).toHaveLength(4);
    });

    it('refuses when the platform admin group is not allowed, and sends nothing', async () => {
      const h = setupCimd(layout);
      open(h);
      h.pocket.s.client.allowed = ['g-console', 'g-dev', 'g-users'];
      await expect(h.api.restrictClient(run())).rejects.toMatchObject({ code: 'IDP_CLIENT' });
      expect(writes(h)).toEqual([]);
      const none = setupCimd(layout);
      open(none);
      none.pocket.s.client.allowed = [];
      await expect(none.api.restrictClient(run())).rejects.toMatchObject({
        message: 'IDP_CLIENT: client_lockout',
      });
    });

    it('is already when restricted, and a dry run sends nothing', async () => {
      const h = setupCimd(layout);
      expect(await h.api.restrictClient(run())).toEqual({ result: 'already', dryRun: false });
      const d = setupCimd(layout);
      open(d);
      expect(await d.api.restrictClient({ ...run(), dryRun: true })).toEqual({
        result: 'restricted',
        dryRun: true,
      });
      expect(writes(d)).toEqual([]);
      expect(d.pocket.s.client.restricted).toBe(false);
    });

    it('does not write when the read lacks a field', async () => {
      const h = setupCimd(layout);
      open(h);
      h.pocket.s.override = (m, p) => {
        if (m !== 'GET' || !p.includes('/oidc/clients/')) return undefined;
        const { requiresReauthentication: _r, ...rest } = {
          id: 'https://passbook.mobile/auth/oidc/client-metadata.json',
          clientType: 'cimd',
          isGroupRestricted: false,
          hasLogo: false,
          hasDarkLogo: false,
          name: 'PassBook',
          allowedUserGroups: [{ id: 'g-admins' }],
          callbackURLs: ['https://passbook.mobile/auth/oidc/callback'],
          requiresReauthentication: false,
        };
        return rest;
      };
      await expect(h.api.restrictClient(run())).rejects.toMatchObject({ code: 'IDP_UPSTREAM' });
      expect(writes(h)).toEqual([]);
    });

    it('is IDP_DRIFT when another edit changes a field between the read and the read back', async () => {
      const h = setupCimd(layout);
      open(h);
      h.fake.cl.transform = (b) => ({ ...b, name: 'Renamed' });
      await expect(h.api.restrictClient(run())).rejects.toMatchObject({ code: 'IDP_DRIFT' });
    });

    it('never sends false on any client write', async () => {
      const h = setupCimd(layout);
      open(h);
      h.pocket.s.client.allowed = [];
      await h.api.allowClientGroups(run('a'));
      await h.api.restrictClient(run('b'));
      await h.api.setClientLogo(run('c'));
      const puts = bodies(h, 'PUT').filter((b) => 'isGroupRestricted' in b);
      expect(puts).toHaveLength(2);
      for (const b of puts) expect(b.isGroupRestricted).toBe(true);
      expect(await rows('idp_calls')).not.toHaveLength(0);
    });
  });

  describe('setClientLogo', () => {
    it('sets both logos from PassBook origin and a fixed path, changing nothing else', async () => {
      const h = setupCimd(layout);
      const res = await h.api.setClientLogo(run());
      expect(res).toEqual({ result: 'set', dryRun: false });
      const [body] = bodies(h, 'PUT');
      expect(body).toMatchObject({
        logoUrl: 'https://passbook.mobile/icons/icon-512.png',
        darkLogoUrl: 'https://passbook.mobile/icons/icon-512.png',
        isGroupRestricted: true,
        name: 'PassBook',
      });
      expect(h.fake.cl.hasLogo && h.fake.cl.hasDarkLogo).toBe(true);
    });

    it('sets only the missing one and is already when both exist', async () => {
      const h = setupCimd(layout);
      h.fake.cl.hasLogo = true;
      await h.api.setClientLogo(run());
      expect(bodies(h, 'PUT')[0]).toMatchObject({
        logoUrl: null,
        darkLogoUrl: 'https://passbook.mobile/icons/icon-512.png',
      });
      expect(await h.api.setClientLogo(run('c2'))).toEqual({ result: 'already', dryRun: false });
    });

    it('needs a restricted client and a CIMD origin', async () => {
      const h = setupCimd(layout);
      h.pocket.s.client.restricted = false;
      await expect(h.api.setClientLogo(run())).rejects.toMatchObject({
        message: 'IDP_CLIENT: client_open',
      });
      expect(writes(h)).toEqual([]);
      const p = setupCimd(layout, { patch: { PASSBOOK_CLIENT_ID: 'client-1' } });
      p.pocket.s.client.id = 'client-1';
      await expect(p.api.setClientLogo(run())).rejects.toMatchObject({ code: 'IDP_REFUSED' });
    });

    it('is IDP_DRIFT when the logo does not stick, and a dry run sends nothing', async () => {
      const h = setupCimd(layout);
      h.fake.cl.transform = (b) => ({ ...b, hasLogo: false, logoUrl: null });
      await expect(h.api.setClientLogo(run())).rejects.toMatchObject({ code: 'IDP_DRIFT' });
      const d = setupCimd(layout);
      expect(await d.api.setClientLogo({ ...run(), dryRun: true })).toEqual({
        result: 'set',
        dryRun: true,
      });
      expect(writes(d)).toEqual([]);
    });
  });

  it('sends only paths of the configured client literal', async () => {
    const h = setupCimd(layout);
    h.pocket.s.client.allowed = [];
    await h.api.allowClientGroups(run('a'));
    await h.api.restrictClient(run('b'));
    const enc = `~${Buffer.from('https://passbook.mobile/auth/oidc/client-metadata.json').toString('base64url')}`;
    for (const w of h.pocket.writes())
      expect(w.path).toMatch(
        new RegExp(`^${base(layout)}/oidc/clients/${enc}(/allowed-user-groups)?$`),
      );
  });
});

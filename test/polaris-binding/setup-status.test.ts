import { beforeEach, describe, expect, it } from 'vitest';
import { CIMD, SCIM_ENDPOINT, TOKEN } from './fake-setup.ts';
import { ledger, resetLedger } from './harness.ts';
import { setupCimd } from './setup-harness.ts';

const sha = async (t: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

beforeEach(resetLedger);

describe.each(['v2', 'admin'] as const)('setupStatus (%s layout)', (layout) => {
  it('reads the client, the roles and the SCIM connection', async () => {
    const h = setupCimd(layout);
    h.pocket.s.client.allowed = ['g-console', 'g-extra'];
    h.fake.sc.provider = { id: 'sp-1', endpoint: SCIM_ENDPOINT, token: TOKEN, lastSyncedAt: 1000 };
    const st = await h.api.setupStatus({ tokenHashes: [await sha('other'), await sha(TOKEN)] });
    expect(st.client).toEqual({
      found: true,
      cimd: true,
      ours: true,
      callbacksOurs: true,
      restricted: true,
      missingRoles: ['developer', 'platform_admin', 'users'],
      aliases: [],
      otherGroups: 1,
      logo: false,
      darkLogo: false,
    });
    expect(st.roles).toEqual({
      console: 'configured',
      developer: 'configured',
      platform_admin: 'configured',
      users: 'configured',
    });
    expect(st.scim).toEqual({ exists: true, endpointOk: true, token: 1, lastSyncedAt: 1000 });
  });

  it('hashes the clear SCIM token and drops it', async () => {
    const h = setupCimd(layout);
    h.fake.sc.provider = {
      id: 'sp-1',
      endpoint: 'https://evil.test/scim/v2',
      token: TOKEN,
      lastSyncedAt: null,
    };
    const none = await h.api.setupStatus();
    expect(none.scim).toEqual({ exists: true, endpointOk: false, token: null, lastSyncedAt: null });
    const other = await h.api.setupStatus({ tokenHashes: [await sha('nope')] });
    expect(other.scim.token).toBe('other');
    expect(JSON.stringify([none, other])).not.toContain(TOKEN);
    expect(JSON.stringify(await ledger())).not.toContain(TOKEN);
  });

  it('says not found when the client has not signed in yet', async () => {
    const h = setupCimd(layout);
    h.fake.cl.found = false;
    const st = await h.api.setupStatus();
    expect(st.client.found).toBe(false);
    expect(st.scim.exists).toBe(false);
  });

  it('reports every role a name-only registry would place', async () => {
    const h = setupCimd(layout, { names: true });
    h.pocket.s.missing.add('g-console');
    h.pocket.s.meta.set('g-dev', {
      friendly: 'd',
      createdAt: 0,
      claims: [{ key: 'other', value: 'x' }],
      clients: [],
    });
    const st = await h.api.setupStatus();
    expect(st.roles).toEqual({
      console: 'create',
      developer: 'in_use',
      platform_admin: 'adopt',
      users: 'adopt',
    });
  });

  it('refuses malformed hashes and caps them at two', async () => {
    const h = setupCimd(layout);
    const ok = 'a'.repeat(64);
    for (const bad of [['x'], [ok, ok, ok], ['A'.repeat(64)], 'a', [1]])
      await expect(h.api.setupStatus({ tokenHashes: bad as never })).rejects.toMatchObject({
        code: 'IDP_REFUSED',
      });
    expect(h.pocket.s.seen).toHaveLength(0);
  });

  it('is budgeted in setup_read and sends only reads', async () => {
    const h = setupCimd(layout);
    for (let i = 0; i < 6; i++) await h.api.setupStatus();
    await expect(h.api.setupStatus()).rejects.toMatchObject({ code: 'IDP_BUDGET' });
    expect(h.pocket.writes()).toHaveLength(0);
    expect((await ledger()).some((r) => r.bucket === 'setup_read' && r.phase === 'start')).toBe(
      true,
    );
  });

  it('reads the configured client only', async () => {
    const h = setupCimd(layout);
    await h.api.setupStatus();
    const base = layout === 'admin' ? '/api/admin' : '/api';
    const enc = `~${Buffer.from(CIMD).toString('base64url')}`;
    expect(h.pocket.s.seen.map((r) => r.path)).toContain(`${base}/oidc/clients/${enc}`);
    expect(h.pocket.s.seen.every((r) => r.method === 'GET')).toBe(true);
  });
});

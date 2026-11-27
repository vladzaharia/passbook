import { describe, expect, it } from 'vitest';
import { type Deps, pocketRequest } from '../../workers/passbook-id-connector/src/pocket-http.ts';
import { envReasons } from '../../workers/passbook-id-connector/src/policy.ts';
import { clientIdOk, encodeClientId } from '../../workers/passbook-id-connector/src/registry.ts';
import { allowedRoutes, routes } from '../../workers/passbook-id-connector/src/routes.ts';
import { baseEnv, NOW, resetLedger, setup } from './harness.ts';

const CIMD = 'https://passbook.mobile/auth/oidc/client-metadata.json';
const ENC = `~${Buffer.from(CIMD).toString('base64url')}`;
const deps = (fetch: typeof globalThis.fetch): Deps => ({ fetch, now: () => NOW });

describe('PASSBOOK_CLIENT_ID', () => {
  it.each([CIMD, 'client-1', 'a.b_c-d'])('accepts %s', (v) => {
    expect(clientIdOk(v)).toBe(true);
    expect(envReasons({ ...baseEnv(), PASSBOOK_CLIENT_ID: v }).reasons).not.toContain('env_client');
  });

  it.each([
    '',
    '~abc',
    '.',
    '..',
    'a..b',
    'a/b',
    `${CIMD}?x=1`,
    `${CIMD}#x`,
    'http://passbook.mobile/auth/oidc/client-metadata.json',
    'https://u@passbook.mobile/auth/oidc/client-metadata.json',
    'https://passbook.mobile/auth/oidc/other.json',
    'https://passbook.mobile/auth/oidc/client-metadata.json/',
    'https://PASSBOOK.mobile/auth/oidc/client-metadata.json',
    `https://passbook.mobile/${'a'.repeat(512)}/auth/oidc/client-metadata.json`,
  ])('refuses %j', (v) => {
    expect(clientIdOk(v)).toBe(false);
    expect(envReasons({ ...baseEnv(), PASSBOOK_CLIENT_ID: v }).reasons).toContain('env_client');
  });

  it('encodes a CIMD id as ~base64url and a plain id as is', () => {
    expect(encodeClientId(CIMD)).toBe(ENC);
    expect(encodeClientId('client-1')).toBe('client-1');
    expect(ENC).toMatch(/^~[A-Za-z0-9_-]+$/);
  });
});

describe.each(['v2', 'admin'] as const)('client path (%s layout)', (layout) => {
  const base = layout === 'admin' ? '/api/admin' : '/api';
  const r = routes(layout);
  const table = allowedRoutes(layout, CIMD);
  const allowed = (method: string, path: string) =>
    table.some((t) => t.method === method && t.path.test(path));

  it('builds and allows exactly the encoded client literal', () => {
    expect(r.client(CIMD)).toBe(`${base}/oidc/clients/${ENC}`);
    expect(allowed('GET', `${base}/oidc/clients/${ENC}`)).toBe(true);
    expect(allowed('GET', `${base}/oidc/clients/~bWU`)).toBe(false);
    expect(allowed('GET', `${base}/oidc/clients/${ENC}x`)).toBe(false);
    expect(allowed('GET', `${base}/oidc/clients/client-1`)).toBe(false);
    // Writes on the same literal: the client itself, its allowed groups and its SCIM connection.
    expect(allowed('PUT', `${base}/oidc/clients/${ENC}`)).toBe(true);
    expect(allowed('PUT', `${base}/oidc/clients/${ENC}/allowed-user-groups`)).toBe(true);
    expect(allowed('GET', `${base}/oidc/clients/${ENC}/scim-service-provider`)).toBe(true);
    expect(allowed('GET', `${base}/oidc/clients/${ENC}/allowed-user-groups`)).toBe(false);
    expect(allowed('DELETE', `${base}/oidc/clients/${ENC}`)).toBe(false);
    expect(allowed('POST', `${base}/oidc/clients/${ENC}/refresh`)).toBe(false);
    expect(allowed('PUT', `${base}/oidc/clients/~bWU`)).toBe(false);
    expect(allowed('PUT', `${base}/oidc/clients/~bWU/allowed-user-groups`)).toBe(false);
  });

  it('allows no client path when the configured id is invalid', () => {
    for (const bad of ['', '~bWU', 'a/b'])
      expect(
        allowedRoutes(layout, bad).some((t) => t.path.test(`${base}/oidc/clients/${bad}`)),
      ).toBe(false);
  });

  it('refuses ~ in every other path segment, builders and allow-list', () => {
    const builders = [
      () => r.group('~bWU'),
      () => r.groupClients('~bWU'),
      () => r.groupClaims('~bWU'),
      () => r.userClaims('~bWU'),
      () => r.user('~bWU'),
      () => r.userGroups('~bWU'),
      () => r.setUserGroups('~bWU'),
      () => r.signupToken('~bWU'),
      () => r.client('~bWU'),
      () => r.clientGroups('~bWU'),
      () => r.scimOf('~bWU'),
      () => r.scim({ id: '~bWU', from: r.scimOf(CIMD) }, CIMD),
      () => r.scimSync({ id: '~bWU', from: r.scimOf(CIMD) }, CIMD),
    ];
    for (const b of builders) expect(b).toThrow(/^IDP_REFUSED|Invalid/);
    const paths: [string, string][] = [
      ['GET', `${base}/user-groups/~bWU`],
      ['PUT', `${base}/user-groups/~bWU`],
      ['DELETE', `${base}/user-groups/~bWU`],
      ['PUT', `${base}/user-groups/~bWU/allowed-oidc-clients`],
      ['PUT', `${base}/custom-claims/user/~bWU`],
      ['PUT', `${base}/custom-claims/user-group/~bWU`],
      ['GET', `${base}/users/~bWU`],
      ['GET', `${base}/users/~bWU/groups`],
      ['PUT', `${base}/users/~bWU`],
      ['PUT', `${base}/users/~bWU/user-groups`],
      ['DELETE', `${base}/signup-tokens/~bWU`],
      ['GET', `${base}/oidc/clients/${ENC}/../users/~bWU`],
      ['PUT', `${base}/scim/service-provider/~bWU`],
      ['POST', `${base}/scim/service-provider/~bWU/sync`],
      ['GET', `${base}/oidc/clients/~bWU/scim-service-provider`],
    ];
    for (const [m, p] of paths) expect(allowed(m, p), `${m} ${p}`).toBe(false);
  });

  it('pocketRequest sends the client read and refuses ~ elsewhere', async () => {
    const env = { ...baseEnv(layout), PASSBOOK_CLIENT_ID: CIMD };
    const seen: string[] = [];
    const d = deps(async (url) => {
      seen.push(new URL(String(url)).pathname);
      return new Response('{}');
    });
    await pocketRequest(env, d, 'GET', `${base}/oidc/clients/${ENC}`);
    expect(seen).toEqual([`${base}/oidc/clients/${ENC}`]);
    for (const p of [`${base}/users/~bWU`, `${base}/user-groups/~bWU`, `${base}/oidc/clients/~bWU`])
      await expect(pocketRequest(env, d, 'GET', p)).rejects.toThrow(/^IDP_MISCONFIGURED/);
    expect(seen).toHaveLength(1);
  });
});

describe('health with a CIMD client', () => {
  it.each(['v2', 'admin'] as const)(
    'reads the client on the %s layout and is safe',
    async (layout) => {
      await resetLedger();
      const { api, pocket } = setup(layout, { PASSBOOK_CLIENT_ID: CIMD });
      pocket.s.client.id = CIMD;
      const h = await api.health();
      expect(h.unsafe).toEqual([]);
      expect(h.warnings).toEqual([]);
      expect(
        pocket.s.seen.some(
          (q) => q.path === `${layout === 'admin' ? '/api/admin' : '/api'}/oidc/clients/${ENC}`,
        ),
      ).toBe(true);
    },
  );

  it('reports client_not_found when Polaris ID has no row yet', async () => {
    await resetLedger();
    const { api } = setup('v2', { PASSBOOK_CLIENT_ID: CIMD });
    expect((await api.health()).warnings).toEqual(['client_not_found']);
  });

  it('is unsafe for an invalid id and sends nothing', async () => {
    await resetLedger();
    const { api, pocket } = setup('v2', { PASSBOOK_CLIENT_ID: 'https://x.test/a.json' });
    expect((await api.health()).unsafe).toContain('env_client');
    expect(pocket.s.seen).toHaveLength(0);
  });
});

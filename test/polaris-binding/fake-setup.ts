import type { FakePocket } from './fake-pocket.ts';
import type { Layout } from './fixtures.ts';

export const CIMD = 'https://passbook.mobile/auth/oidc/client-metadata.json';
export const ENC = `~${Buffer.from(CIMD).toString('base64url')}`;
export const SCIM_ENDPOINT = 'https://passbook.mobile/scim/v2';
export const TOKEN = 'T'.repeat(43);
export const TOKEN2 = 'U'.repeat(43);

/** The update fields Polaris ID binds from one DTO: a missing one fails validation, as at v2.19.3. */
const FIELDS = [
  'name',
  'description',
  'callbackURLs',
  'logoutCallbackURLs',
  'backchannelLogoutURL',
  'isPublic',
  'pkceEnabled',
  'requiresReauthentication',
  'requiresPushedAuthorizationRequests',
  'skipConsent',
  'credentials',
  'launchURL',
  'hasLogo',
  'hasDarkLogo',
  'logoUrl',
  'darkLogoUrl',
  'isGroupRestricted',
  'accessTokenDurationMinutes',
  'refreshTokenDurationMinutes',
];

export interface Provider {
  id: string;
  endpoint: string;
  token: string;
  lastSyncedAt: number | null;
}

/**
 * The client and SCIM routes of Polaris ID at v2.19.3 over the fake: the full client DTO (with `clientType`), the
 * echo PUT (`isGroupRestricted: false` clears the allowed groups), allowed groups replaced as a set, and the SCIM
 * provider, which answers its token in clear on every read.
 */
export function installSetup(pocket: FakePocket, layout: Layout, clock: { now: number }) {
  const s = pocket.s;
  const base = layout === 'admin' ? '/api/admin' : '/api';
  const cl = {
    found: true,
    clientType: 'cimd',
    hasLogo: false,
    hasDarkLogo: false,
    fields: {
      name: 'PassBook',
      description: '',
      callbackURLs: ['https://passbook.mobile/auth/oidc/callback'],
      logoutCallbackURLs: [] as string[],
      backchannelLogoutURL: '',
      isPublic: true,
      pkceEnabled: true,
      requiresReauthentication: false,
      requiresPushedAuthorizationRequests: false,
      skipConsent: false,
      credentials: { secrets: [] as unknown[] },
      launchURL: null as string | null,
      accessTokenDurationMinutes: 60,
      refreshTokenDurationMinutes: 43200,
    },
    /** Rewrites the body a client PUT stores (drift). */
    transform: undefined as ((b: Record<string, unknown>) => Record<string, unknown>) | undefined,
    /** Rewrites the ids an allowed-groups PUT stores (drift). */
    allowedTransform: undefined as ((ids: string[]) => string[]) | undefined,
  };
  const sc = { provider: null as Provider | null };
  s.client.id = CIMD;
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const clientDto = () => ({
    id: s.client.id,
    clientType: cl.clientType,
    hasLogo: cl.hasLogo,
    hasDarkLogo: cl.hasDarkLogo,
    ...cl.fields,
    isGroupRestricted: s.client.restricted,
    allowedUserGroups: s.client.allowed.map((id) => ({ id, name: id })),
  });
  const providerDto = (p: Provider) => ({
    id: p.id,
    endpoint: p.endpoint,
    token: p.token,
    lastSyncedAt: p.lastSyncedAt === null ? null : new Date(p.lastSyncedAt).toISOString(),
    oidcClient: { id: s.client.id },
    createdAt: new Date(clock.now).toISOString(),
  });
  const decode = (raw: string) =>
    raw.startsWith('~') ? Buffer.from(raw.slice(1), 'base64url').toString() : raw;

  s.extra = (method, path, body) => {
    const m = path.match(
      new RegExp(`^${base}/oidc/clients/([^/]+)(/allowed-user-groups|/scim-service-provider)?$`),
    );
    if (m) {
      if (decode(m[1] as string) !== s.client.id || !cl.found)
        return json({ error: 'not found' }, 404);
      if (!m[2] && method === 'GET') return json(clientDto());
      if (!m[2] && method === 'PUT') {
        const b = body as Record<string, unknown>;
        if (FIELDS.some((f) => !(f in b))) return json({ error: 'invalid' }, 400);
        const stored = cl.transform ? cl.transform(b) : b;
        Object.assign(
          cl.fields,
          Object.fromEntries(Object.keys(cl.fields).map((k) => [k, stored[k]])),
        );
        s.client.restricted = stored.isGroupRestricted === true;
        // `false` clears the allowed groups (A7).
        if (!s.client.restricted) s.client.allowed = [];
        cl.hasLogo = stored.hasLogo === true || typeof stored.logoUrl === 'string';
        cl.hasDarkLogo = stored.hasDarkLogo === true || typeof stored.darkLogoUrl === 'string';
        return json(clientDto());
      }
      if (m[2] === '/allowed-user-groups' && method === 'PUT') {
        const ids = (body as { userGroupIds: string[] }).userGroupIds;
        s.client.allowed = cl.allowedTransform ? cl.allowedTransform(ids) : ids;
        return json(null, 204);
      }
      if (m[2] === '/scim-service-provider' && method === 'GET')
        return sc.provider ? json(providerDto(sc.provider)) : json({ error: 'not found' }, 404);
    }
    if (path === `${base}/scim/service-provider` && method === 'POST') {
      const b = body as { endpoint: string; token: string; oidcClientId: string };
      if (b.oidcClientId !== s.client.id || sc.provider) return json({ error: 'invalid' }, 400);
      sc.provider = { id: 'sp-1', endpoint: b.endpoint, token: b.token, lastSyncedAt: null };
      return json(providerDto(sc.provider), 201);
    }
    const p = path.match(new RegExp(`^${base}/scim/service-provider/([^/]+)(/sync)?$`));
    if (p) {
      if (!sc.provider || sc.provider.id !== p[1]) return json({ error: 'not found' }, 404);
      if (method === 'PUT' && !p[2]) {
        const b = body as { endpoint: string; token: string };
        sc.provider = { ...sc.provider, endpoint: b.endpoint, token: b.token };
        return json(providerDto(sc.provider));
      }
      if (method === 'POST' && p[2]) {
        sc.provider.lastSyncedAt = clock.now;
        return json(null, 204);
      }
    }
    return undefined;
  };
  return { cl, sc };
}
export type FakeSetup = ReturnType<typeof installSetup>;

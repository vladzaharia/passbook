import { failure, ok, type Req } from './pocket-http.ts';
import { ID } from './registry.ts';
import type { Shared } from './shared.ts';
import { IdpError } from './types.ts';

const unexpected = () => new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected client.');
const unexpectedScim = () =>
  new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected SCIM connection.');

export interface ClientView {
  id: string;
  clientType: string;
  restricted: boolean;
  hasLogo: boolean;
  hasDarkLogo: boolean;
  allowed: string[];
  /** The DTO as read; `echoBody` turns it into an update body. */
  raw: Record<string, unknown>;
}

const FLAGS = [
  'isPublic',
  'pkceEnabled',
  'requiresReauthentication',
  'requiresPushedAuthorizationRequests',
  'skipConsent',
] as const;

function allowedIds(c: Record<string, unknown>): string[] {
  if (!Array.isArray(c.allowedUserGroups)) throw unexpected();
  return c.allowedUserGroups.map((g) => {
    const id = (g as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !ID.test(id)) throw unexpected();
    return id;
  });
}

/** The client DTO's own facts. A missing flag fails the read: it is never "off". */
export function parseClient(body: unknown): ClientView {
  const c = body as Record<string, unknown> | null;
  if (
    !c ||
    typeof c !== 'object' ||
    typeof c.id !== 'string' ||
    typeof c.clientType !== 'string' ||
    typeof c.isGroupRestricted !== 'boolean' ||
    typeof c.hasLogo !== 'boolean' ||
    typeof c.hasDarkLogo !== 'boolean'
  )
    throw unexpected();
  return {
    id: c.id,
    clientType: c.clientType,
    restricted: c.isGroupRestricted,
    hasLogo: c.hasLogo,
    hasDarkLogo: c.hasDarkLogo,
    allowed: allowedIds(c),
    raw: c,
  };
}

const list = (v: unknown): string[] => {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw unexpected();
  return v as string[];
};

/**
 * The full update body, echoed from a read: Polaris ID binds one DTO and an omitted field resets. `isGroupRestricted`
 * is the literal `true` on every body, so no write of this Worker can send `false` (which clears the allowed groups).
 */
export function echoBody(
  v: ClientView,
  logos: { logoUrl?: string; darkLogoUrl?: string } = {},
): Record<string, unknown> {
  const c = v.raw;
  const num = (k: string) => {
    if (typeof c[k] !== 'number') throw unexpected();
    return c[k];
  };
  for (const f of FLAGS) if (typeof c[f] !== 'boolean') throw unexpected();
  if (
    typeof c.name !== 'string' ||
    typeof c.description !== 'string' ||
    typeof c.backchannelLogoutURL !== 'string' ||
    !c.credentials ||
    typeof c.credentials !== 'object' ||
    (c.launchURL !== null && typeof c.launchURL !== 'string')
  )
    throw unexpected();
  return {
    name: c.name,
    description: c.description,
    callbackURLs: list(c.callbackURLs),
    logoutCallbackURLs: list(c.logoutCallbackURLs),
    backchannelLogoutURL: c.backchannelLogoutURL,
    isPublic: c.isPublic,
    pkceEnabled: c.pkceEnabled,
    requiresReauthentication: c.requiresReauthentication,
    requiresPushedAuthorizationRequests: c.requiresPushedAuthorizationRequests,
    skipConsent: c.skipConsent,
    credentials: c.credentials,
    launchURL: c.launchURL,
    hasLogo: v.hasLogo,
    hasDarkLogo: v.hasDarkLogo,
    logoUrl: logos.logoUrl ?? null,
    darkLogoUrl: logos.darkLogoUrl ?? null,
    isGroupRestricted: true,
    accessTokenDurationMinutes: num('accessTokenDurationMinutes'),
    refreshTokenDurationMinutes: num('refreshTokenDurationMinutes'),
  };
}

/** Every echoed field equal, but for the named ones. */
export function sameFields(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  except: string[] = [],
): boolean {
  return Object.keys(a).every(
    (k) => except.includes(k) || JSON.stringify(a[k]) === JSON.stringify(b[k]),
  );
}

/** `GET` of the configured client. Not found and not ours are `IDP_CLIENT`: nothing else is ever written. */
export async function readClient(s: Shared, req: Req): Promise<ClientView> {
  const res = await req('GET', s.r.client(s.env.PASSBOOK_CLIENT_ID));
  if (res.status === 404) throw new IdpError('IDP_CLIENT', 'client_not_found');
  if (!ok(res)) throw failure(res);
  const c = parseClient(res.body);
  if (c.id !== s.env.PASSBOOK_CLIENT_ID) throw new IdpError('IDP_CLIENT', 'client_not_ours');
  return c;
}

export interface Provider {
  id: string;
  endpoint: string;
  /** Polaris ID answers its SCIM token in clear on every read. It is hashed and dropped by the caller. */
  token: string;
  lastSyncedAt: number | null;
}

/** The client's SCIM connection, or null when it has none. */
export async function readProvider(s: Shared, req: Req): Promise<Provider | null> {
  const res = await req('GET', s.r.scimOf(s.env.PASSBOOK_CLIENT_ID));
  if (res.status === 404) return null;
  if (!ok(res)) throw failure(res);
  const p = res.body as Record<string, unknown> | null;
  if (
    !p ||
    typeof p.id !== 'string' ||
    !ID.test(p.id) ||
    typeof p.endpoint !== 'string' ||
    typeof p.token !== 'string'
  )
    throw unexpectedScim();
  const at = typeof p.lastSyncedAt === 'string' ? Date.parse(p.lastSyncedAt) : Number.NaN;
  return {
    id: p.id,
    endpoint: p.endpoint,
    token: p.token,
    lastSyncedAt: Number.isNaN(at) ? null : at,
  };
}

/**
 * OIDC relying-party client, ported from polaris-key. Every URL it dials passes an https +
 * allowlist gate, redirects are never followed, bodies are size-capped and JWKS verification
 * uses a local key set (no library-driven fetches).
 */
import {
  createLocalJWKSet,
  type JSONWebKeySet,
  type JWTPayload,
  errors as joseErrors,
  jwtVerify,
} from 'jose';
import { randomBytes, sha256Base64Url, toBase64Url } from '../../platform/ids.ts';
import type { Logger } from '../../platform/log.ts';
import { isIpLiteral } from '../../platform/safe-fetch.ts';

export const ALLOWED_ID_TOKEN_ALGS: readonly string[] = ['RS256', 'ES256', 'EdDSA'];
export const ID_TOKEN_MAX_AGE = '5m';
export const ID_TOKEN_CLOCK_TOLERANCE = 60;
export const OIDC_MAX_BYTES = 64 * 1024;
export const OIDC_TIMEOUT_MS = 10_000;

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
/** An unknown `kid` refetches the key set at most once per interval. */
const JWKS_REFRESH_FLOOR_MS = 60 * 1000;
const DISCOVERY_CACHE_PREFIX = 'https://oidc-cache.invalid/discovery/';

export class OidcNetworkError extends Error {
  override name = 'OidcNetworkError';
}
/** The IdP refused the grant itself (replayed, expired or foreign code). */
export class OidcGrantRefusedError extends Error {
  override name = 'OidcGrantRefusedError';
}
export class OidcVerifyError extends Error {
  override name = 'OidcVerifyError';
}

export type OidcFetch = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: OidcFetch = (input, init) => fetch(input, init);

export interface RelyingParty {
  issuer: string;
  clientId: string;
  clientSecret?: string | null;
  allowedHosts: readonly string[];
  algorithms?: readonly string[];
  /** Dev only: permit http on a loopback host (the mock provider). */
  allowLoopbackHttp?: boolean;
}

export function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '');
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why `raw` may not be dialled, or null when it may. */
export function oidcUrlProblem(
  raw: unknown,
  allowedHosts: readonly string[],
  allowLoopbackHttp = false,
): string | null {
  if (typeof raw !== 'string' || !raw) return 'not a URL';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  const host = canonicalHost(url.hostname);
  const loopback = allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK.has(host);
  if (url.protocol !== 'https:' && !loopback) return 'not https';
  if (url.username || url.password) return 'embeds credentials';
  if (url.port !== '' && !loopback) return 'names a port';
  if (!loopback) {
    if (isIpLiteral(host)) return 'IP literal';
    if (!host.includes('.') || /\.(local|internal|localhost)$/.test(host)) return 'reserved host';
  }
  if (!allowedHosts.some((h) => canonicalHost(h) === host)) return 'host not on the allowlist';
  return null;
}

/** Relying party for the configured issuer; its allowlist is the issuer host alone. */
export function issuerRelyingParty(cfg: {
  issuer: string;
  clientId: string;
  clientSecret?: string | null;
  allowLoopbackHttp?: boolean;
}): RelyingParty {
  return {
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret ?? null,
    allowedHosts: [canonicalHost(new URL(cfg.issuer).hostname)],
    allowLoopbackHttp: cfg.allowLoopbackHttp ?? false,
  };
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > OIDC_MAX_BYTES) throw new OidcNetworkError('response too large');
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > OIDC_MAX_BYTES) {
      await reader.cancel();
      throw new OidcNetworkError('response too large');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function oauthError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed?.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

async function gatedJson(
  label: string,
  url: string,
  init: RequestInit,
  rp: Pick<RelyingParty, 'allowedHosts' | 'allowLoopbackHttp'>,
  fetchImpl: OidcFetch = defaultFetch,
): Promise<Record<string, unknown>> {
  const problem = oidcUrlProblem(url, rp.allowedHosts, rp.allowLoopbackHttp);
  if (problem) throw new OidcNetworkError(`refused ${label} URL: ${problem}`);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
    });
  } catch {
    throw new OidcNetworkError(`${label} request failed`);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new OidcNetworkError(`${label} answered a redirect`);
  }
  const body = await readCapped(res);
  if (res.status < 200 || res.status >= 300) {
    if (res.status === 400 && oauthError(body) === 'invalid_grant') {
      throw new OidcGrantRefusedError(`${label} refused the grant`);
    }
    throw new OidcNetworkError(`${label} answered ${res.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new OidcNetworkError(`${label} answered invalid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OidcNetworkError(`${label} answered a non-object`);
  }
  return parsed as Record<string, unknown>;
}

export interface DiscoveredIssuer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  endSessionEndpoint: string | null;
  /** RFC 9207: the issuer sends `iss` on every authorization response. */
  issParameterSupported: boolean;
  allowedHosts: readonly string[];
  allowLoopbackHttp: boolean;
}

const discoveryCache = new Map<string, { value: DiscoveredIssuer; expires: number }>();
const jwksCache = new Map<string, { value: JSONWebKeySet; expires: number; fetchedAt: number }>();

function discoveryCacheUrl(issuer: string): string {
  return `${DISCOVERY_CACHE_PREFIX}${encodeURIComponent(issuer)}`;
}

export async function resetOidcClientCaches(issuer?: string): Promise<void> {
  discoveryCache.clear();
  jwksCache.clear();
  if (issuer) await caches.default.delete(discoveryCacheUrl(issuer));
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function endpoint(rp: RelyingParty, doc: Record<string, unknown>, field: string): string {
  const raw = doc[field];
  const problem = oidcUrlProblem(raw, rp.allowedHosts, rp.allowLoopbackHttp);
  if (problem) throw new OidcVerifyError(`discovery ${field} refused: ${problem}`);
  return raw as string;
}

function interpret(rp: RelyingParty, doc: Record<string, unknown>): DiscoveredIssuer {
  if (doc.issuer !== rp.issuer) throw new OidcVerifyError('discovery issuer mismatch');
  if (!stringList(doc.response_types_supported).includes('code')) {
    throw new OidcVerifyError('issuer does not support the code flow');
  }
  return {
    issuer: rp.issuer,
    authorizationEndpoint: endpoint(rp, doc, 'authorization_endpoint'),
    tokenEndpoint: endpoint(rp, doc, 'token_endpoint'),
    jwksUri: endpoint(rp, doc, 'jwks_uri'),
    endSessionEndpoint:
      doc.end_session_endpoint === undefined ? null : endpoint(rp, doc, 'end_session_endpoint'),
    issParameterSupported: doc.authorization_response_iss_parameter_supported === true,
    allowedHosts: [...rp.allowedHosts],
    allowLoopbackHttp: rp.allowLoopbackHttp ?? false,
  };
}

/** The Cache API is an optimisation; any failure falls back to the network. */
async function cachedDocument(url: string, log: Logger): Promise<Record<string, unknown> | null> {
  try {
    const hit = await caches.default.match(url);
    return hit ? ((await hit.json()) as Record<string, unknown>) : null;
  } catch {
    log.warn('oidc.cache_failed', { code: 'CACHE_READ' });
    return null;
  }
}

async function storeDocument(
  url: string,
  doc: Record<string, unknown>,
  log: Logger,
): Promise<void> {
  try {
    await caches.default.put(
      url,
      new Response(JSON.stringify(doc), {
        headers: { 'cache-control': `max-age=${DISCOVERY_TTL_MS / 1000}` },
      }),
    );
  } catch {
    log.warn('oidc.cache_failed', { code: 'CACHE_WRITE' });
  }
}

/** The issuer's discovery document, validated; cached per isolate and in the Cache API. */
export async function discover(
  rp: RelyingParty,
  opts: { fetch?: OidcFetch; nowMs: number; log: Logger },
): Promise<DiscoveredIssuer> {
  const { nowMs, log } = opts;
  const key = `${rp.issuer}\n${rp.allowedHosts.join(',')}`;
  const hit = discoveryCache.get(key);
  if (hit && hit.expires > nowMs) return hit.value;
  const cacheUrl = discoveryCacheUrl(rp.issuer);
  const cached = await cachedDocument(cacheUrl, log);
  let value: DiscoveredIssuer | null = null;
  if (cached) {
    try {
      value = interpret(rp, cached);
    } catch {
      value = null; // stale or poisoned entry: refetch
    }
  }
  if (!value) {
    const doc = await gatedJson(
      'discovery',
      `${rp.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
      { headers: { accept: 'application/json' } },
      rp,
      opts.fetch,
    );
    value = interpret(rp, doc);
    await storeDocument(cacheUrl, doc, log);
  }
  discoveryCache.set(key, { value, expires: nowMs + DISCOVERY_TTL_MS });
  return value;
}

/** RFC 9207: `iss` must be present when promised, and equal the issuer whenever present. */
export function checkAuthorizationIss(
  discovered: Pick<DiscoveredIssuer, 'issuer' | 'issParameterSupported'>,
  iss: string | null,
): void {
  if (iss === null) {
    if (discovered.issParameterSupported) {
      throw new OidcVerifyError('authorization response lacks iss');
    }
    return;
  }
  if (iss !== discovered.issuer) throw new OidcVerifyError('authorization response iss mismatch');
}

export async function newFlowSecrets(): Promise<{
  state: string;
  nonce: string;
  verifier: string;
  challenge: string;
}> {
  const verifier = toBase64Url(randomBytes(32));
  return {
    state: toBase64Url(randomBytes(24)),
    nonce: toBase64Url(randomBytes(24)),
    verifier,
    challenge: await sha256Base64Url(verifier),
  };
}

export function authorizationUrl(
  discovered: Pick<DiscoveredIssuer, 'authorizationEndpoint'>,
  rp: Pick<RelyingParty, 'clientId'>,
  flow: {
    redirectUri: string;
    scope: string;
    state: string;
    nonce: string;
    codeChallenge: string;
    /** `login` makes the provider ask who is signing in (another account). */
    prompt?: 'login';
  },
): string {
  const u = new URL(discovered.authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', rp.clientId);
  u.searchParams.set('redirect_uri', flow.redirectUri);
  u.searchParams.set('scope', flow.scope);
  u.searchParams.set('state', flow.state);
  u.searchParams.set('nonce', flow.nonce);
  u.searchParams.set('code_challenge', flow.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (flow.prompt) u.searchParams.set('prompt', flow.prompt);
  return u.toString();
}

async function exchangeCode(
  discovered: DiscoveredIssuer,
  rp: RelyingParty,
  grant: { code: string; redirectUri: string; codeVerifier: string },
  fetchImpl?: OidcFetch,
): Promise<{ id_token: string }> {
  const tokens = await gatedJson(
    'token',
    discovered.tokenEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: grant.code,
        redirect_uri: grant.redirectUri,
        client_id: rp.clientId,
        code_verifier: grant.codeVerifier,
        ...(rp.clientSecret ? { client_secret: rp.clientSecret } : {}),
      }).toString(),
    },
    discovered,
    fetchImpl,
  );
  if (typeof tokens.id_token !== 'string') {
    throw new OidcVerifyError('token response has no id_token');
  }
  return { id_token: tokens.id_token };
}

async function loadJwks(
  discovered: DiscoveredIssuer,
  opts: { fetch?: OidcFetch; nowMs: number; refresh: boolean },
): Promise<JSONWebKeySet> {
  const hit = jwksCache.get(discovered.jwksUri);
  if (hit && hit.expires > opts.nowMs) {
    const mayRefresh = opts.nowMs - hit.fetchedAt >= JWKS_REFRESH_FLOOR_MS;
    if (!opts.refresh || !mayRefresh) return hit.value;
  }
  const doc = await gatedJson(
    'jwks',
    discovered.jwksUri,
    { headers: { accept: 'application/json' } },
    discovered,
    opts.fetch,
  );
  if (!Array.isArray(doc.keys)) throw new OidcVerifyError('JWKS has no keys');
  const value = { keys: doc.keys } as JSONWebKeySet;
  jwksCache.set(discovered.jwksUri, {
    value,
    expires: opts.nowMs + JWKS_TTL_MS,
    fetchedAt: opts.nowMs,
  });
  return value;
}

/** Signature, iss, exact aud, azp, alg, freshness and nonce. */
export async function verifyIdToken(
  discovered: DiscoveredIssuer,
  rp: Pick<RelyingParty, 'issuer' | 'clientId' | 'algorithms'>,
  token: string,
  expect: { nonce: string; fetch?: OidcFetch; nowMs: number },
): Promise<JWTPayload> {
  if (!rp.clientId) throw new OidcVerifyError('no audience configured');
  const { nowMs } = expect;
  const verifyWith = async (refresh: boolean): Promise<JWTPayload> => {
    const jwks = await loadJwks(discovered, { fetch: expect.fetch, nowMs, refresh });
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: rp.issuer,
      audience: rp.clientId,
      algorithms: [...(rp.algorithms ?? ALLOWED_ID_TOKEN_ALGS)],
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE,
      maxTokenAge: ID_TOKEN_MAX_AGE,
      currentDate: new Date(nowMs),
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
    });
    return payload;
  };
  let payload: JWTPayload;
  try {
    try {
      payload = await verifyWith(false);
    } catch (err) {
      if (!(err instanceof joseErrors.JWKSNoMatchingKey)) throw err;
      payload = await verifyWith(true);
    }
  } catch (err) {
    if (err instanceof OidcVerifyError || err instanceof OidcNetworkError) throw err;
    throw new OidcVerifyError(`token refused: ${err instanceof Error ? err.message : 'invalid'}`);
  }
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== rp.clientId) {
    throw new OidcVerifyError('multi-audience token without matching azp');
  }
  if (payload.azp !== undefined && payload.azp !== rp.clientId) {
    throw new OidcVerifyError('azp mismatch');
  }
  if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
    throw new OidcVerifyError('token has no subject');
  }
  if (payload.nonce !== expect.nonce) throw new OidcVerifyError('nonce mismatch');
  return payload;
}

/** RFC 9207 check, token request and ID token verification for one callback. */
export async function redeemAuthorizationCode(
  rp: RelyingParty,
  response: {
    code: string;
    iss: string | null;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
  },
  opts: { fetch?: OidcFetch; nowMs: number; log: Logger },
): Promise<{ claims: JWTPayload; discovered: DiscoveredIssuer }> {
  const discovered = await discover(rp, opts);
  checkAuthorizationIss(discovered, response.iss);
  const tokens = await exchangeCode(
    discovered,
    rp,
    { code: response.code, redirectUri: response.redirectUri, codeVerifier: response.codeVerifier },
    opts.fetch,
  );
  const claims = await verifyIdToken(discovered, rp, tokens.id_token, {
    nonce: response.nonce,
    fetch: opts.fetch,
    nowMs: opts.nowMs,
  });
  return { claims, discovered };
}

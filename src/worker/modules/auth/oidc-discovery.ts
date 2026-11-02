import type { Logger } from '../../platform/log.ts';
import {
  DISCOVERY_CACHE_PREFIX,
  DISCOVERY_TTL_MS,
  gatedJson,
  type OidcFetch,
  OidcVerifyError,
  oidcUrlProblem,
  type RelyingParty,
} from './oidc-http.ts';

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

export function discoveryCacheUrl(issuer: string): string {
  return `${DISCOVERY_CACHE_PREFIX}${encodeURIComponent(issuer)}`;
}

export function clearDiscoveryCache(): void {
  discoveryCache.clear();
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

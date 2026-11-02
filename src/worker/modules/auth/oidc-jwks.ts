import {
  createLocalJWKSet,
  type JSONWebKeySet,
  type JWTPayload,
  errors as joseErrors,
  jwtVerify,
} from 'jose';
import type { DiscoveredIssuer } from './oidc-discovery.ts';
import {
  ALLOWED_ID_TOKEN_ALGS,
  gatedJson,
  ID_TOKEN_CLOCK_TOLERANCE,
  ID_TOKEN_MAX_AGE,
  JWKS_REFRESH_FLOOR_MS,
  JWKS_TTL_MS,
  type OidcFetch,
  OidcNetworkError,
  OidcVerifyError,
  type RelyingParty,
} from './oidc-http.ts';

const jwksCache = new Map<string, { value: JSONWebKeySet; expires: number; fetchedAt: number }>();

export function clearJwksCache(): void {
  jwksCache.clear();
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

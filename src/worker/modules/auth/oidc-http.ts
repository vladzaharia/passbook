import { isIpLiteral } from '../../platform/safe-fetch.ts';

/** Shared pieces of the OIDC client: errors, URL gate, capped JSON fetch. */
export const ALLOWED_ID_TOKEN_ALGS: readonly string[] = ['RS256', 'ES256', 'EdDSA'];
export const ID_TOKEN_MAX_AGE = '5m';
export const ID_TOKEN_CLOCK_TOLERANCE = 60;
export const OIDC_MAX_BYTES = 64 * 1024;
export const OIDC_TIMEOUT_MS = 10_000;

export const DISCOVERY_TTL_MS = 60 * 60 * 1000;
export const JWKS_TTL_MS = 60 * 60 * 1000;
/** An unknown `kid` refetches the key set at most once per interval. */
export const JWKS_REFRESH_FLOOR_MS = 60 * 1000;
export const DISCOVERY_CACHE_PREFIX = 'https://oidc-cache.invalid/discovery/';

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

export async function readCapped(res: Response): Promise<string> {
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

export async function gatedJson(
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

import type { GoogleValidatedAccount } from './google-credentials.ts';
import { GOOGLE_WALLET_SCOPE } from './google-credentials.ts';
import { googleIssuedAt, signGoogleJwt } from './google-crypto.ts';
import { GoogleWalletError, googleFetch, googleHttpError } from './google-errors.ts';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface GoogleAccessToken {
  accessToken: string;
  expiresAt: number;
}

/** Identifies the credentials a token was minted from; a new revision never reuses an old token. */
export interface GoogleTokenCacheKey {
  accountId: string;
  revision: number;
}

export interface GoogleTokenOptions {
  issuedAt: number;
  fetcher?: typeof fetch;
  /** Reuse tokens per isolate for this account revision. Omit to always mint. */
  cacheKey?: GoogleTokenCacheKey;
}

interface CachedToken extends GoogleAccessToken {
  revision: number;
  reuseUntil: number;
}

// Per isolate and in memory only: a token is never persisted, logged or shared across isolates.
const REUSE_FRACTION = 0.8;
const MAX_CACHED_ACCOUNTS = 256;
const tokenCache = new Map<string, CachedToken>();

/** Forget the token after a 401 or when a test needs a cold isolate. */
export function dropGoogleAccessToken(accountId?: string): void {
  if (accountId === undefined) tokenCache.clear();
  else tokenCache.delete(accountId);
}

export function isGoogleBearerToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~+/-]+={0,2}$/.test(value);
}

// https://developers.google.com/identity/protocols/oauth2/service-account#httprest
export async function getGoogleAccessToken(
  account: GoogleValidatedAccount,
  options: GoogleTokenOptions,
): Promise<GoogleAccessToken> {
  if (!options) throw new GoogleWalletError('invalid_input', 'oauth');
  const issuedAt = googleIssuedAt(options.issuedAt);
  const cacheKey = options.cacheKey;
  if (cacheKey) {
    const cached = tokenCache.get(cacheKey.accountId);
    if (cached && cached.revision !== cacheKey.revision) tokenCache.delete(cacheKey.accountId);
    else if (cached && issuedAt < cached.reuseUntil)
      return { accessToken: cached.accessToken, expiresAt: cached.expiresAt };
  }
  const assertion = await signGoogleJwt(account, {
    iss: account.serviceAccountEmail,
    scope: GOOGLE_WALLET_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: issuedAt,
    exp: issuedAt + 300,
  });
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const response = await googleFetch(
    options.fetcher ?? globalThis.fetch,
    TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    'oauth',
  );
  if (!response.ok)
    throw googleHttpError('oauth', response.status, response.headers, issuedAt * 1000);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new GoogleWalletError('invalid_response', 'oauth');
  }
  if (!json || typeof json !== 'object') throw new GoogleWalletError('invalid_response', 'oauth');
  const token = json as Record<string, unknown>;
  if (
    !isGoogleBearerToken(token.access_token) ||
    typeof token.token_type !== 'string' ||
    token.token_type.toLowerCase() !== 'bearer' ||
    typeof token.expires_in !== 'number' ||
    !Number.isSafeInteger(token.expires_in) ||
    token.expires_in <= 0 ||
    issuedAt > Number.MAX_SAFE_INTEGER - token.expires_in ||
    (token.scope !== undefined && token.scope !== GOOGLE_WALLET_SCOPE)
  ) {
    throw new GoogleWalletError('invalid_response', 'oauth');
  }
  const minted = { accessToken: token.access_token, expiresAt: issuedAt + token.expires_in };
  if (cacheKey) {
    tokenCache.delete(cacheKey.accountId);
    if (tokenCache.size >= MAX_CACHED_ACCOUNTS) {
      const oldest = tokenCache.keys().next().value;
      if (oldest !== undefined) tokenCache.delete(oldest);
    }
    tokenCache.set(cacheKey.accountId, {
      ...minted,
      revision: cacheKey.revision,
      reuseUntil: issuedAt + Math.floor(token.expires_in * REUSE_FRACTION),
    });
  }
  return minted;
}

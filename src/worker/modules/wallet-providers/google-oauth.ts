import type { GoogleValidatedAccount } from './google-credentials.ts';
import { GOOGLE_WALLET_SCOPE } from './google-credentials.ts';
import { googleIssuedAt, signGoogleJwt } from './google-crypto.ts';
import { GoogleWalletError, googleFetch, googleHttpError } from './google-errors.ts';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface GoogleAccessToken {
  accessToken: string;
  expiresAt: number;
}

export interface GoogleTokenOptions {
  issuedAt: number;
  fetcher?: typeof fetch;
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
  if (!response.ok) throw googleHttpError('oauth', response.status);
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
  return { accessToken: token.access_token, expiresAt: issuedAt + token.expires_in };
}

import type { JWTPayload } from 'jose';
import { randomBytes, sha256Base64Url, toBase64Url } from '../../platform/ids.ts';
import type { Logger } from '../../platform/log.ts';
import { checkAuthorizationIss, type DiscoveredIssuer, discover } from './oidc-discovery.ts';
import { gatedJson, type OidcFetch, OidcVerifyError, type RelyingParty } from './oidc-http.ts';
import { verifyIdToken } from './oidc-jwks.ts';

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

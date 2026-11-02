/**
 * Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document). When
 * OIDC_CLIENT_ID is this deployment's metadata URL, Polaris ID registers PassBook itself by
 * fetching the document: a public client (PKCE, no secret), so no client to create by hand.
 */
import type { Context } from 'hono';
import type { AppBindings } from '../../platform/context.ts';
import { type AppEnv, baseUrl, envString } from '../../platform/env.ts';
import { NotFoundError } from '../../platform/errors.ts';

export const CIMD_PATH = '/auth/oidc/client-metadata.json';
export const OIDC_SCOPE = 'openid email profile groups';

type UrlEnv = Pick<AppEnv, 'PUBLIC_BASE_URL'>;

export const cimdClientId = (env: UrlEnv) => `${baseUrl(env)}${CIMD_PATH}`;
export const oidcRedirectUri = (env: UrlEnv) => `${baseUrl(env)}/auth/oidc/callback`;
export const postLogoutRedirectUri = (env: UrlEnv) => `${baseUrl(env)}/login`;

/** The client id is our own metadata URL, which only an https deployment can serve. */
export function usesCimd(env: UrlEnv): boolean {
  const url = cimdClientId(env);
  return url.startsWith('https://') && envString(env, 'OIDC_CLIENT_ID') === url;
}

export function clientMetadata(env: UrlEnv) {
  const base = baseUrl(env);
  return {
    client_id: cimdClientId(env),
    client_name: 'PassBook',
    client_uri: base,
    logo_uri: `${base}/apple-touch-icon.png`,
    redirect_uris: [oidcRedirectUri(env)],
    post_logout_redirect_uris: [postLogoutRedirectUri(env)],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: OIDC_SCOPE,
  };
}

/** GET /auth/oidc/client-metadata.json. Cacheable: Polaris ID stores the client it resolves. */
export function clientMetadataDocument(c: Context<AppBindings>) {
  if (!usesCimd(c.env)) throw new NotFoundError();
  return c.json(clientMetadata(c.env), 200, { 'cache-control': 'public, max-age=3600' });
}

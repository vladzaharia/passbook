/**
 * OIDC relying-party client, ported from polaris-key. Every URL it dials passes an https +
 * allowlist gate, redirects are never followed, bodies are size-capped and JWKS verification
 * uses a local key set (no library-driven fetches).
 */
import { clearDiscoveryCache, discoveryCacheUrl } from './oidc-discovery.ts';
import { clearJwksCache } from './oidc-jwks.ts';

export * from './oidc-discovery.ts';
export * from './oidc-http.ts';
export * from './oidc-jwks.ts';
export * from './oidc-token.ts';

export async function resetOidcClientCaches(issuer?: string): Promise<void> {
  clearDiscoveryCache();
  clearJwksCache();
  if (issuer) await caches.default.delete(discoveryCacheUrl(issuer));
}

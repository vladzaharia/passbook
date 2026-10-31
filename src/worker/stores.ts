import { type AuthStores, denyAllStores } from './platform/auth.ts';
import type { AppEnv } from './platform/env.ts';

/**
 * Production session and API-key stores. Foundation denies everything; the auth module
 * implements `SessionStore` (D1 sessions) and the api-keys module `ApiKeyStore`, and this
 * function wires them. Owner: integration.
 */
export function createAuthStores(_env: AppEnv): AuthStores {
  return denyAllStores;
}

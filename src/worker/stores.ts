import { createApiKeyStore } from './modules/api-keys/service.ts';
import { createSessionStore } from './modules/auth/sessions.ts';
import type { AuthStores } from './platform/auth.ts';
import type { AppEnv } from './platform/env.ts';

/** Production session (D1) and API-key stores, wired into createApp by index.ts. */
export function createAuthStores(env: AppEnv): AuthStores {
  return { sessions: createSessionStore(env), apiKeys: createApiKeyStore(env) };
}

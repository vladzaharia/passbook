import type {
  ApiKeyAuth,
  ApiScope,
  AuthStores,
  Role,
  SessionAuth,
} from '../../src/worker/platform/auth.ts';
import { SESSION_COOKIE } from '../../src/worker/platform/auth.ts';
import type { DeniedEvent } from '../../src/worker/platform/denied.ts';

export interface FakeAuth {
  stores: AuthStores;
  /** Events passed to onDenied, in order. */
  denied: DeniedEvent[];
  /** Headers for a cookie session. Includes the CSRF token and same-origin hints for unsafe methods. */
  session(options?: { userId?: string; roles?: Role[]; origin?: string }): Record<string, string>;
  admin(): Record<string, string>;
  user(userId?: string): Record<string, string>;
  /** Headers for a bearer API key. */
  apiKey(options?: { orgId?: string | null; scopes?: ApiScope[] }): Record<string, string>;
}

/**
 * Fakes authentication so module routes can be tested before the auth module exists:
 * `createApp({ stores: fakeAuth().stores })`, then send `fake.admin()` headers.
 */
export function fakeAuth(origin = 'https://wallet.test'): FakeAuth {
  const sessions = new Map<string, SessionAuth>();
  const keys = new Map<string, ApiKeyAuth>();
  const denied: DeniedEvent[] = [];
  let n = 0;
  return {
    denied,
    stores: {
      sessions: { resolve: async (cookie) => sessions.get(cookie) ?? null },
      apiKeys: { resolve: async (raw) => keys.get(raw) ?? null },
      onDenied: (event) => {
        denied.push(event);
      },
    },
    session({ userId = 'user-1', roles = ['user'] as Role[], origin: o = origin } = {}) {
      const id = `fake-session-${++n}`;
      const csrfSecret = `fake-csrf-${n}`;
      sessions.set(id, { kind: 'session', userId, sessionId: id, roles, csrfSecret, amr: 'oidc' });
      return {
        cookie: `${SESSION_COOKIE}=${id}`,
        'x-csrf-token': csrfSecret,
        origin: o,
        'sec-fetch-site': 'same-origin',
      };
    },
    admin() {
      return this.session({ userId: 'admin-1', roles: ['admin', 'user'] });
    },
    user(userId = 'user-1') {
      return this.session({ userId, roles: ['user'] });
    },
    apiKey({
      orgId = null,
      scopes = ['passes:read', 'passes:write', 'holders:write', 'templates:read'] as ApiScope[],
    } = {}) {
      const raw = `wlt_fake${++n}_secret`;
      keys.set(raw, { kind: 'api_key', keyId: `key-${n}`, orgId, scopes });
      return { authorization: `Bearer ${raw}` };
    },
  };
}

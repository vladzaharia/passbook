import type { Mode } from '../../src/shared/contracts/common.ts';
import type {
  ApiKeyAuth,
  ApiScope,
  AuthStores,
  Role,
  ScannerAuth,
  SessionAuth,
} from '../../src/worker/platform/auth.ts';
import { SCANNER_COOKIE, SESSION_COOKIE } from '../../src/worker/platform/auth.ts';
import type { DeniedEvent } from '../../src/worker/platform/denied.ts';

export interface FakeAuth {
  stores: AuthStores;
  /** Events passed to onDenied, in order. */
  denied: DeniedEvent[];
  /** Headers for a cookie session. Includes the CSRF token and same-origin hints for unsafe methods. */
  session(options?: {
    userId?: string;
    roles?: Role[];
    origin?: string;
    mode?: Mode;
  }): Record<string, string>;
  /** `mode: 'test'` sends x-passbook-mode: test, as the admin UI does. */
  admin(options?: { mode?: Mode }): Record<string, string>;
  user(userId?: string): Record<string, string>;
  /**
   * Headers for a paired scanner: a cookie device (with CSRF token and same-origin hints) or a
   * bearer terminal.
   */
  scanner(options?: {
    scannerId?: string;
    orgId?: string;
    mode?: Mode;
    transport?: 'cookie' | 'bearer';
    origin?: string;
  }): Record<string, string>;
  /** Headers for a bearer API key. */
  apiKey(options?: {
    orgId?: string | null;
    scopes?: ApiScope[];
    mode?: Mode;
  }): Record<string, string>;
}

/**
 * Fakes authentication so module routes can be tested before the auth module exists:
 * `createApp({ stores: fakeAuth().stores })`, then send `fake.admin()` headers.
 */
export function fakeAuth(origin = 'https://wallet.test'): FakeAuth {
  const sessions = new Map<string, SessionAuth>();
  const keys = new Map<string, ApiKeyAuth>();
  const scanners = new Map<string, ScannerAuth>();
  const denied: DeniedEvent[] = [];
  let n = 0;
  return {
    denied,
    stores: {
      sessions: { resolve: async (cookie) => sessions.get(cookie) ?? null },
      apiKeys: { resolve: async (raw) => keys.get(raw) ?? null },
      scanners: {
        resolve: async (token, transport) => {
          const found = scanners.get(token);
          return found?.transport === transport ? found : null;
        },
      },
      onDenied: (event) => {
        denied.push(event);
      },
    },
    session({ userId = 'user-1', roles = ['user'] as Role[], origin: o = origin, mode } = {}) {
      const id = `fake-session-${++n}`;
      const csrfSecret = `fake-csrf-${n}`;
      sessions.set(id, {
        kind: 'session',
        userId,
        sessionId: id,
        roles,
        csrfSecret,
        amr: 'oidc',
        mode: 'live',
      });
      return {
        cookie: `${SESSION_COOKIE}=${id}`,
        'x-csrf-token': csrfSecret,
        origin: o,
        'sec-fetch-site': 'same-origin',
        ...(mode ? { 'x-passbook-mode': mode } : {}),
      };
    },
    admin({ mode }: { mode?: Mode } = {}) {
      return this.session({
        userId: 'admin-1',
        roles: ['admin', 'user'],
        ...(mode ? { mode } : {}),
      });
    },
    user(userId = 'user-1') {
      return this.session({ userId, roles: ['user'] });
    },
    scanner({
      scannerId = 'scanner-1',
      orgId = 'org-1',
      mode = 'live' as Mode,
      transport = 'cookie' as 'cookie' | 'bearer',
      origin: o = origin,
    } = {}) {
      const token = `wls_${String(++n).padStart(8, 'f')}_${'A'.repeat(43)}`;
      const csrfSecret = transport === 'cookie' ? `fake-scan-csrf-${n}` : null;
      scanners.set(token, { kind: 'scanner', scannerId, orgId, mode, transport, csrfSecret });
      const headers: Record<string, string> =
        transport === 'bearer'
          ? { authorization: `Bearer ${token}` }
          : {
              cookie: `${SCANNER_COOKIE}=${token}`,
              'x-csrf-token': csrfSecret ?? '',
              origin: o,
              'sec-fetch-site': 'same-origin',
            };
      return headers;
    },
    apiKey({
      orgId = null,
      scopes = ['passes:read', 'passes:write', 'holders:write', 'templates:read'] as ApiScope[],
      mode = 'live' as Mode,
    } = {}) {
      const raw = `wlt_fake${++n}_secret`;
      keys.set(raw, { kind: 'api_key', keyId: `key-${n}`, orgId, scopes, mode });
      return { authorization: `Bearer ${raw}` };
    },
  };
}

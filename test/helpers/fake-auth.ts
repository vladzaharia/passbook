import type { Mode } from '../../src/shared/contracts/common.ts';
import { createApiKeyStore } from '../../src/worker/modules/api-keys/service.ts';
import type {
  ApiKeyAuth,
  ApiKeyStore,
  ApiScope,
  AuthStores,
  Role,
  ScannerAuth,
  SessionAuth,
} from '../../src/worker/platform/auth.ts';
import { SCANNER_COOKIE, SESSION_COOKIE } from '../../src/worker/platform/auth.ts';
import type { Clock } from '../../src/worker/platform/clock.ts';
import { run, stmt } from '../../src/worker/platform/db.ts';
import type { DeniedEvent } from '../../src/worker/platform/denied.ts';
import type { AppEnv } from '../../src/worker/platform/env.ts';
import { randomBytes, sha256Hex, toBase64Url } from '../../src/worker/platform/ids.ts';

export interface FakeAuth {
  stores: AuthStores;
  /** Events passed to onDenied, in order. */
  denied: DeniedEvent[];
  /**
   * Seed sessions in D1 on their first resolution, before returning the fake principal.
   * Existing user state is never reset; each resolution slides the idle expiry like a real session.
   */
  bindSessions(db: D1Database, clock: Clock): void;
  /** Seed generated keys in D1 and resolve them through the production API-key store. */
  bindApiKeys(env: AppEnv, clock: Clock): void;
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
   * bearer terminal. Only the principal is faked. `requireScanActor` also reads the `scanners` row,
   * so a test that goes through the guard seeds one with `makeScanner`, which is the frozen helper
   * for scan tests, and uses its headers.
   */
  scanner(options?: {
    scannerId?: string;
    orgId?: string;
    mode?: Mode;
    transport?: 'cookie' | 'bearer';
    kind?: ScannerAuth['scannerKind'];
    deviceRole?: ScannerAuth['deviceRole'];
    origin?: string;
  }): Record<string, string>;
  /** Headers for a bearer API key. */
  apiKey(options?: {
    orgId?: string | null;
    scopes?: ApiScope[];
    mode?: Mode;
  }): Record<string, string>;
}

interface FakeSession {
  auth: SessionAuth;
  seeded: WeakMap<D1Database, Promise<SessionAuth>>;
}

interface FakeApiKey {
  auth: ApiKeyAuth;
  prefix: string;
  seeded: WeakMap<D1Database, Promise<void>>;
}

async function seedApiKey(
  db: D1Database,
  clock: Clock,
  raw: string,
  key: FakeApiKey,
): Promise<void> {
  await run(
    db,
    `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      key.auth.orgId,
      'Test key',
      key.prefix,
      await sha256Hex(raw),
      JSON.stringify(key.auth.scopes),
      key.auth.mode,
      clock.now(),
    ],
  );
}

const IDLE_MS = 3_600_000;

async function seedSession(
  db: D1Database,
  clock: Clock,
  cookie: string,
  session: SessionAuth,
): Promise<SessionAuth> {
  const sessionId = await sha256Hex(cookie);
  const now = clock.now();
  await db.batch([
    stmt(
      db,
      'INSERT INTO users (id, primary_email, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING',
      [session.userId, `${crypto.randomUUID()}@fake-auth.test`, now],
    ),
    stmt(
      db,
      `INSERT INTO sessions
        (id_hash, user_id, amr, roles, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        session.userId,
        session.amr,
        JSON.stringify(session.roles),
        session.csrfSecret,
        now,
        now,
        now + IDLE_MS,
        now + 12 * 3_600_000,
      ],
    ),
  ]);
  return { ...session, sessionId };
}

/**
 * Fakes authentication so module routes can be tested before the auth module exists:
 * `createApp({ stores: fakeAuth().stores })`, then send `fake.admin()` headers.
 */
export function fakeAuth(origin = 'https://wallet.test'): FakeAuth {
  const sessions = new Map<string, FakeSession>();
  const keys = new Map<string, FakeApiKey>();
  const scanners = new Map<string, ScannerAuth>();
  const denied: DeniedEvent[] = [];
  let n = 0;
  let binding: { db: D1Database; clock: Clock } | undefined;
  let keyBinding: { db: D1Database; clock: Clock; store: ApiKeyStore } | undefined;
  return {
    denied,
    bindSessions(db, clock) {
      binding = { db, clock };
    },
    bindApiKeys(env, clock) {
      keyBinding = { db: env.DB, clock, store: createApiKeyStore(env, clock) };
    },
    stores: {
      sessions: {
        resolve: async (cookie) => {
          const session = sessions.get(cookie);
          if (!session) return null;
          if (!binding) return session.auth;
          const { db, clock } = binding;
          let seeded = session.seeded.get(db);
          if (!seeded) {
            seeded = seedSession(db, clock, cookie, session.auth);
            session.seeded.set(db, seeded);
          }
          const seededAuth = await seeded;
          // Real sessions slide the idle window on use (auth/repo-sessions.ts touchSession).
          await run(
            db,
            `UPDATE sessions SET last_seen_at = ?, idle_expires_at = MIN(expires_at, ?)
             WHERE id_hash = ? AND revoked_at IS NULL`,
            [clock.now(), clock.now() + IDLE_MS, await sha256Hex(cookie)],
          );
          return seededAuth;
        },
      },
      apiKeys: {
        resolve: async (raw) => {
          const key = keys.get(raw);
          if (!key) return null;
          if (!keyBinding) return key.auth;
          const { db, clock, store } = keyBinding;
          let seeded = key.seeded.get(db);
          if (!seeded) {
            seeded = seedApiKey(db, clock, raw, key);
            key.seeded.set(db, seeded);
          }
          await seeded;
          return store.resolve(raw);
        },
      },
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
      const id = crypto.randomUUID();
      const csrfSecret = `fake-csrf-${++n}`;
      sessions.set(id, {
        auth: {
          kind: 'session',
          userId,
          sessionId: id,
          roles,
          csrfSecret,
          amr: 'oidc',
          mode: 'live',
        },
        seeded: new WeakMap(),
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
      kind = transport === 'bearer' ? 'terminal' : 'device',
      deviceRole = 'scan',
      origin: o = origin,
    }: {
      scannerId?: string;
      orgId?: string;
      mode?: Mode;
      transport?: 'cookie' | 'bearer';
      kind?: ScannerAuth['scannerKind'];
      deviceRole?: ScannerAuth['deviceRole'];
      origin?: string;
    } = {}) {
      const token = `wls_${String(++n).padStart(8, 'f')}_${'A'.repeat(43)}`;
      const csrfSecret = transport === 'cookie' ? `fake-scan-csrf-${n}` : null;
      scanners.set(token, {
        kind: 'scanner',
        scannerId,
        orgId,
        mode,
        transport,
        csrfSecret,
        scannerKind: kind,
        deviceRole,
      });
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
      n++;
      const prefix = toBase64Url(randomBytes(6));
      const raw = `wlt_${prefix}_${toBase64Url(randomBytes(32))}`;
      keys.set(raw, {
        // Existing in-memory fixtures use sequential IDs; D1 keys need independent unique IDs.
        auth: { kind: 'api_key', keyId: `key-${n}`, orgId, scopes, mode },
        prefix,
        seeded: new WeakMap(),
      });
      return { authorization: `Bearer ${raw}` };
    },
  };
}

import { CREDENTIAL_SCOPES } from '../../src/shared/contracts/api-keys.ts';
import type { Mode } from '../../src/shared/contracts/common.ts';
import type {
  Amr,
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
import { withoutTrigger } from './triggers.ts';

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
    /** How the session was made; `magic_link` is an email session (holder features only). */
    amr?: Amr;
    /** An email session's console grace end (ms). */
    consoleUntil?: number | null;
    /** When the sign-in was proven (ms). Default: now, so a step-up route passes; null is a session with none. */
    authTime?: number | null;
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
    /** Default: `platform` without an org, else `service`. A forged row may pair `platform` with an org. */
    keyKind?: NonNullable<ApiKeyAuth['keyKind']>;
    /** Default: a sequential id. A test of a per-key limiter names one no other test of the file spends. */
    keyId?: string;
  }): Record<string, string>;
  /** Headers for a Platform key (kind `platform`, no org) holding platform scopes. */
  platformKey(options?: { scopes?: ApiScope[]; keyId?: string }): Record<string, string>;
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

/** The active user a seeded platform key is made by. */
export const FAKE_KEY_CREATOR = 'fake-key-creator';

async function seedApiKey(
  db: D1Database,
  clock: Clock,
  raw: string,
  key: FakeApiKey,
): Promise<void> {
  // An org-less key stands for a platform key from before 0142: unbounded, past the insert rules. A platform
  // key lives only while its creator does, so it is made by an active user of its own.
  const creator = key.auth.orgId === null ? FAKE_KEY_CREATOR : null;
  if (creator)
    await run(db, 'INSERT OR IGNORE INTO users (id, primary_email, created_at) VALUES (?, ?, ?)', [
      creator,
      `${creator}@fake-auth.test`,
      clock.now(),
    ]);
  const insert = async () =>
    run(
      db,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        key.auth.orgId,
        'Test key',
        key.prefix,
        await sha256Hex(raw),
        JSON.stringify(key.auth.scopes),
        key.auth.mode,
        clock.now(),
        key.auth.orgId === null ? 'platform' : 'service',
        // A credential scope counts only on a key that expires within 91 days.
        key.auth.scopes.some((s) => (CREDENTIAL_SCOPES as readonly string[]).includes(s))
          ? clock.now() + 30 * 86_400_000
          : null,
        creator,
      ],
    );
  await (key.auth.orgId === null ? withoutTrigger(db, 'api_keys_kind_rules', insert) : insert());
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
      // A sign-in records the roles it granted, as `recordLogin` does; deferred platform work reads them.
      `INSERT INTO users (id, primary_email, created_at, last_roles) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_roles = excluded.last_roles`,
      [session.userId, `${crypto.randomUUID()}@fake-auth.test`, now, JSON.stringify(session.roles)],
    ),
    stmt(
      db,
      // A Polaris ID session implies a linked identity, which a personal key needs (KEY_OWNER_NEEDS_IDP).
      `INSERT OR IGNORE INTO auth_identities (provider, subject, user_id, created_at)
       SELECT 'pocketid', 'fake-' || ?1, ?1, ?2 WHERE ?3 = 'oidc'`,
      [session.userId, now, session.amr],
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
  let keyBinding: { db: D1Database; clock: Clock; store: Promise<ApiKeyStore> } | undefined;
  const fake: FakeAuth = {
    denied,
    bindSessions(db, clock) {
      binding = { db, clock };
    },
    bindApiKeys(env, clock) {
      // Loaded on first use: the service pulls ~50 modules most tests never need.
      keyBinding = {
        db: env.DB,
        clock,
        store: import('../../src/worker/modules/api-keys/service.ts').then((m) =>
          m.createApiKeyStore(env, clock),
        ),
      };
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
          return (await store).resolve(raw);
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
    session({
      userId = 'user-1',
      roles = ['user'] as Role[],
      origin: o = origin,
      mode,
      amr = 'oidc' as Amr,
      consoleUntil = null as number | null,
      authTime = Date.now() as number | null,
    } = {}) {
      const id = crypto.randomUUID();
      const csrfSecret = `fake-csrf-${++n}`;
      sessions.set(id, {
        auth: {
          kind: 'session',
          userId,
          sessionId: id,
          roles,
          csrfSecret,
          amr,
          consoleUntil,
          authTime,
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
      keyKind = orgId === null ? 'platform' : 'service',
      keyId,
    } = {}) {
      n++;
      const prefix = toBase64Url(randomBytes(6));
      const raw = `wlt_${prefix}_${toBase64Url(randomBytes(32))}`;
      keys.set(raw, {
        // Existing in-memory fixtures use sequential IDs; D1 keys need independent unique IDs.
        auth: {
          kind: 'api_key',
          keyId: keyId ?? `key-${n}`,
          orgId,
          scopes,
          mode,
          keyKind,
        },
        prefix,
        seeded: new WeakMap(),
      });
      return { authorization: `Bearer ${raw}` };
    },
    platformKey({ scopes = ['platform:read'] as ApiScope[], keyId } = {}) {
      return fake.apiKey({ orgId: null, scopes, ...(keyId ? { keyId } : {}) });
    },
  };
  return fake;
}

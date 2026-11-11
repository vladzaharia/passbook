import { expect } from 'vitest';
import {
  type Fixtures,
  fakeRateLimiter,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeScanner,
  makeSession,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { createScannerStore } from './auth-store.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { scanningSessionRow } from './repo-scanning-sessions.ts';
import {
  recordSessionCountScan,
  type SessionCountScanOptions,
} from './repo-session-count-scope-test-fixtures.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { grantScanMembership } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';

export async function freshFixture(providedEnv?: AppEnv) {
  const env = providedEnv ?? (await makeEnv());
  Object.assign(env, {
    RL_SCAN: fakeRateLimiter({ limit: 100_000 }),
    RL_SCAN_ORG: fakeRateLimiter({ limit: 100_000 }),
    RL_SCAN_LOOKUP: fakeRateLimiter({ limit: 100_000 }),
  });
  const clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  const fx = fixtures(env, clock);
  const org = await makeOrg(fx);
  const user = await makeUser(fx);
  const membershipId = await grantScanMembership(fx, org.id, user.id, ['org_admin']);
  const browser = await makeSession(fx, { userId: user.id });
  const store = createSessionStore(env, clock);
  const auth = await store.resolve(browser.cookieValue);
  if (!auth) throw new Error('Missing session count reader');
  const ctx = createServiceContext(env, { clock });
  const id = fx.ids.id();
  await run(
    env.DB,
    `INSERT INTO scanning_sessions
    (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
    VALUES (?,?,'live','Private session','active',NULL,?,'UTC',?,?)`,
    [id, org.id, JSON.stringify(DEFAULT_SETTINGS), clock.now(), clock.now()],
  );
  const row = await scanningSessionRow(env.DB, org.id, id);
  if (!row) throw new Error('Missing scanning session');
  const read = await tenantAuthorityOf(ctx, auth, org.id, 'scanning:read');
  const proof = await captureConsoleSessionCountAuthority(ctx, auth, read);
  const app = createApp({
    clock,
    stores: { ...denyAllStores, sessions: store, scanners: createScannerStore(env, clock) },
  });
  const request = (
    path: string,
    headers: Record<string, string> = browser.headers,
    init: RequestInit = {},
  ) =>
    Promise.resolve(
      app.request(
        `${ORIGIN}/api/v1${path}`,
        {
          ...init,
          headers: {
            ...headers,
            origin: ORIGIN,
            ...(init.body ? { 'content-type': 'application/json' } : {}),
          },
        },
        env,
      ),
    );
  return { env, clock, fx, org, user, membershipId, browser, auth, ctx, id, row, proof, request };
}

interface Fixture {
  env: AppEnv;
  clock: ManualClock;
  fx: Fixtures;
  org: { id: string };
}
type Captured = { sql: string; params: unknown[] };

/** Intervene just before the transaction that initializes and reads the singleton. */
export async function atCountBatch<T>(
  env: AppEnv,
  operation: () => Promise<T>,
  intervene: (db: D1Database) => Promise<void>,
  corrupt?: (results: D1Result[], statements: (Captured | undefined)[]) => D1Result[],
): Promise<{ result: T; captured: Captured[] }> {
  const real = env.DB;
  const bound = new WeakMap<D1PreparedStatement, Captured>();
  const captured: Captured[] = [];
  let hits = 0;
  const db = new Proxy(real, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...params: unknown[]) => {
                  const result = statement.bind(...params);
                  bound.set(result, { sql, params });
                  return result;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const byStatement = statements.map((statement) => bound.get(statement));
          const entries = byStatement.filter((entry): entry is Captured => !!entry);
          const selected =
            !hits &&
            entries.some((entry) => /WITH\s+session_scope\s+AS\s+MATERIALIZED/i.test(entry.sql));
          if (selected) {
            hits++;
            captured.push(...entries);
            await intervene(real);
          }
          const results = await target.batch(statements);
          return selected && corrupt ? corrupt(results, byStatement) : results;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  env.DB = db;
  try {
    const result = await operation();
    expect(hits).toBe(1);
    return { result, captured };
  } finally {
    env.DB = real;
  }
}

/** Simulate pre-existing retired references after a singleton loss, without weakening fixture triggers. */
export async function insertExistingReference(f: Fixture) {
  const trigger = await first<{ sql: string }>(
    f.env.DB,
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='pass_credential_tombstones_insert_guard'",
  );
  if (!trigger?.sql) throw new Error('Missing tombstone guard');
  await run(f.env.DB, 'DROP TRIGGER pass_credential_tombstones_insert_guard');
  try {
    await run(
      f.env.DB,
      `INSERT INTO pass_credential_tombstones
      (pass_id,org_id,mode,credential_generation,credential_kind,credential_hash,retired_at)
      VALUES (?,?, 'live',1,'scan_code',?,?)`,
      [f.fx.ids.id(), f.org.id, 'a'.repeat(64), f.clock.now()],
    );
  } finally {
    await run(f.env.DB, trigger.sql);
  }
}

export async function singleton(f: Fixture) {
  return first<{ commitment: string }>(
    f.env.DB,
    'SELECT commitment FROM credential_ref_keyset WHERE id=1',
  );
}

/** Model an unexpected same-revision scanner secret replacement. */
export async function withMutableScannerSecret<T>(
  db: D1Database,
  scannerId: string,
  secret: string,
  work: () => Promise<T>,
) {
  const trigger = await first<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='scanners_credential_revision'",
  );
  if (!trigger?.sql) throw new Error('Missing scanner credential guard');
  await run(db, 'DROP TRIGGER scanners_credential_revision');
  try {
    return await work();
  } finally {
    await run(db, 'UPDATE scanners SET csrf_secret=? WHERE id=?', [secret, scannerId]);
    await run(db, trigger.sql);
  }
}

/** Seed the same mixed session, presence and ledger data that a console list encounters. */
export async function seedSessionListStats(f: Fixture & { id: string }) {
  const now = f.clock.now();
  const date = new Date(now);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const foreign = await makeOrg(f.fx);
  const template = makeTemplate({ id: f.fx.ids.id(), orgId: f.org.id });
  const foreignTemplate = makeTemplate({ id: f.fx.ids.id(), orgId: foreign.id });
  const pass = await makePass(f.fx, { orgId: f.org.id, template: template.resolved });
  const testPass = await makePass(f.fx, {
    orgId: f.org.id,
    mode: 'test',
    template: template.resolved,
  });
  const quarantined = await makePass(f.fx, { orgId: f.org.id, template: template.resolved });
  const foreignPass = await makePass(f.fx, {
    orgId: foreign.id,
    template: foreignTemplate.resolved,
  });
  await run(f.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [quarantined.id]);
  const ids = {
    second: f.fx.ids.id(),
    empty: f.fx.ids.id(),
    test: f.fx.ids.id(),
    denied: f.fx.ids.id(),
  };
  for (const [id, orgId, mode] of [
    [ids.second, f.org.id, 'live'],
    [ids.empty, f.org.id, 'live'],
    [ids.test, f.org.id, 'test'],
    [ids.denied, foreign.id, 'live'],
  ]) {
    await run(
      f.env.DB,
      `INSERT INTO scanning_sessions
      (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
      VALUES (?,?,?,'Other session','active',NULL,?,'UTC',?,?)`,
      [id, orgId, mode, JSON.stringify(DEFAULT_SETTINGS), now, now],
    );
  }
  const device = async (
    sessionId: string,
    options: Partial<Parameters<typeof makeScanner>[1]> = {},
    bindingMode = options.mode ?? 'live',
  ) => {
    const scanner = await makeScanner(f.fx, { orgId: f.org.id, ...options });
    await run(
      f.env.DB,
      'INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode) VALUES (?,?,?,?)',
      [scanner.id, sessionId, options.orgId ?? f.org.id, bindingMode],
    );
    return scanner.id;
  };
  const online = await device(f.id);
  await device(f.id, { lastSeenAt: now - 120_000 });
  const offline = await device(f.id, { lastSeenAt: now - 120_001 });
  await device(f.id, { lastSeenAt: null });
  const revoked = await device(f.id, { revoked: true });
  const wrongScannerMode = await device(f.id, { mode: 'test' }, 'live');
  const wrongDeviceMode = await device(f.id, {}, 'test');
  const secondDevice = await device(ids.second);
  const testDevice = await device(ids.test, { mode: 'test' });
  const foreignDevice = await device(ids.denied, { orgId: foreign.id });
  const scans: (SessionCountScanOptions & { scannerId: string; passId?: string })[] = [
    { scannerId: online, at: dayStart },
    { scannerId: offline },
    { scannerId: revoked },
    { scannerId: secondDevice },
    { scannerId: secondDevice },
    { scannerId: testDevice, mode: 'test', passId: testPass.id },
    { scannerId: foreignDevice, orgId: foreign.id, passId: foreignPass.id },
    { scannerId: online, state: 'pending' },
    { scannerId: online, state: 'failed' },
    { scannerId: online, outcome: 'heads_up' },
    { scannerId: online, outcome: 'refused' },
    { scannerId: online, actionKind: 'undo' },
    { scannerId: online, undoneBy: f.fx.ids.id() },
    { scannerId: online, at: dayStart - 1 },
    { scannerId: online, orgId: foreign.id, passId: foreignPass.id },
    { scannerId: online, mode: 'test', passId: testPass.id },
    { scannerId: wrongScannerMode },
    { scannerId: wrongDeviceMode },
    { scannerId: online, passId: foreignPass.id },
    { scannerId: online, passId: testPass.id },
    { scannerId: online, passId: quarantined.id },
    { scannerId: online, actorId: foreignDevice },
  ];
  const privateIds = [pass.id, testPass.id, foreignPass.id, quarantined.id];
  for (const scan of scans) {
    privateIds.push(
      await recordSessionCountScan(f.fx, f.org.id, scan.scannerId, scan.passId ?? pass.id, scan),
    );
  }
  return { ...ids, foreignOrgId: foreign.id, privateIds };
}

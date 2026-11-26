import { env } from 'cloudflare:workers';
import migration from '../../workers/passbook-id-connector/migrations/0001_binding.sql?raw';
import { createApi } from '../../workers/passbook-id-connector/src/api.ts';
import type { Deps } from '../../workers/passbook-id-connector/src/pocket-http.ts';
import type {
  ApplyCtx,
  BindingEnv,
  Target,
  WriteCtx,
} from '../../workers/passbook-id-connector/src/types.ts';
import { CLIENT_ID, type FakePocket, fakePocket, GROUPS } from './fake-pocket.ts';
import type { Layout } from './fixtures.ts';

export const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
export const API_KEY = 'test-api-key';
export const ORIGIN = 'https://id.test';

/** The GROUPS var: console, developer and the two protected entries; `support` is opt in. */
export const groupsJson = (opts: { support?: boolean } = {}) =>
  JSON.stringify({
    console: GROUPS.console,
    developer: GROUPS.developer,
    ...(opts.support ? { support: GROUPS.support } : {}),
    platform_admin: { ...GROUPS.platform_admin, protected: true },
    users: { ...GROUPS.users, protected: true },
  });

export const baseEnv = (layout: Layout = 'v2'): BindingEnv => ({
  DB: env.DB,
  POCKET_ID_API_KEY: API_KEY,
  POCKET_ID_ORIGIN: ORIGIN,
  POCKET_ID_API: layout,
  GROUPS: groupsJson(),
  GROUP_PREFIX: 'passbook_',
  WRITE_MODE: 'live',
  PASSBOOK_CLIENT_ID: CLIENT_ID,
});

export const ctx = (over: Partial<ApplyCtx> = {}): ApplyCtx => ({
  ref: 'run-1',
  reason: 'sync',
  actor: { kind: 'system', job: 'drain' },
  ...over,
});
export const userCtx = (over: Partial<WriteCtx> = {}): WriteCtx =>
  ctx({ actor: { kind: 'user', id: 'admin-1' }, ...over });

const TABLES = [
  'idp_calls',
  'idp_grants',
  'idp_subjects',
  'idp_signups',
  'idp_health',
  'idp_breaker',
  'idp_freezes',
  'idp_locks',
  'idp_groups',
];

/** The binding's tables in the worker project's D1; each test recreates them (the setup drops triggers it did not migrate). */
export async function resetLedger(): Promise<void> {
  for (const t of TABLES) await env.DB.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  const statements = migration
    .split('\n')
    .filter((l) => !l.startsWith('--'))
    .join('\n')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) await env.DB.prepare(sql).run();
}

/** An API over a fake Polaris ID of the given layout. `patch` overrides settings, e.g. a wrong group id. */
export function setup(layout: Layout = 'v2', patch: Partial<BindingEnv> = {}) {
  const clock = { now: NOW };
  const pocket: FakePocket = fakePocket(layout, clock);
  const deps: Deps = { now: () => clock.now, fetch: pocket.fetch };
  const benv = { ...baseEnv(layout), ...patch };
  return { api: createApi(benv, deps), pocket, clock, env: benv, deps };
}

export async function rows(table: string) {
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all<
    Record<string, unknown>
  >();
  return results;
}
export const ledger = () => rows('idp_calls');

/** Every binding table as one string, to prove a secret is stored nowhere. */
export async function dumpAll(): Promise<string> {
  const out: unknown[] = [];
  for (const t of TABLES) out.push(await rows(t));
  return JSON.stringify(out);
}

/** Everything the binding writes to the console while `fn` runs, as one string per line. */
export async function captureLogs<T>(
  fn: () => Promise<T>,
): Promise<{ lines: string[]; result: T | undefined; error: unknown }> {
  const lines: string[] = [];
  const saved = { ...console };
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
    console[level] = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  try {
    return { lines, result: await fn(), error: undefined };
  } catch (error) {
    return { lines, result: undefined, error };
  } finally {
    Object.assign(console, saved);
  }
}

export async function seedGrant(
  subject: string,
  role: Target = 'developer',
  source: 'signup' | 'added' = 'added',
): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO idp_subjects (subject, class, created_at) VALUES (?, 'linked', ?)",
  )
    .bind(subject, NOW)
    .run();
  await env.DB.prepare(
    'INSERT INTO idp_grants (subject, target, source, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(subject, role, source, NOW, NOW)
    .run();
}

/** Marks an account as one a proven signup created, so `setDisabled` may manage it. */
export async function seedCreated(subject: string): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO idp_subjects (subject, class, created_at) VALUES (?, 'created', ?)",
  )
    .bind(subject, NOW)
    .run();
}

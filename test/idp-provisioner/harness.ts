import { env } from 'cloudflare:workers';
import migration from '../../workers/idp-provisioner/migrations/0001_idp.sql?raw';
import { createApi } from '../../workers/idp-provisioner/src/api.ts';
import type { Deps } from '../../workers/idp-provisioner/src/pocket-http.ts';
import type { ProvisionerEnv } from '../../workers/idp-provisioner/src/types.ts';
import { DEV_GROUP, type FakePocket, fakePocket } from './fake-pocket.ts';
import type { Layout } from './fixtures.ts';

export const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
export const API_KEY = 'pid-KEYSECRET-0123456789';
export const ORIGIN = 'https://id.test';

export const baseEnv = (layout: Layout = 'v2'): ProvisionerEnv => ({
  DB: env.DB,
  POCKET_ID_API_KEY: API_KEY,
  POCKET_ID_ORIGIN: ORIGIN,
  POCKET_ID_API: layout,
  DEVELOPER_GROUP_ID: DEV_GROUP.id,
  DEVELOPER_GROUP_NAME: DEV_GROUP.name,
  PROTECTED_GROUP_NAMES: 'wallet_admins,wallet_org_admins,wallet_users',
});

const TABLES = ['idp_calls', 'idp_grants', 'idp_signups', 'idp_health'];

/** The provisioner's tables in the worker project's D1; each test recreates them (the setup drops triggers it did not migrate). */
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

/** An API over a fake Pocket ID of the given layout. `patch` overrides settings, e.g. a wrong group id. */
export function setup(layout: Layout = 'v2', patch: Partial<ProvisionerEnv> = {}) {
  const clock = { now: NOW };
  const pocket: FakePocket = fakePocket(layout, clock);
  const deps: Deps = { now: () => clock.now, fetch: pocket.fetch };
  const penv = { ...baseEnv(layout), ...patch };
  return { api: createApi(penv, deps), pocket, clock, env: penv, deps };
}

export async function rows(table: string) {
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all<
    Record<string, unknown>
  >();
  return results;
}
export const ledger = () => rows('idp_calls');

/** Every provisioner table as one string, to prove a secret is stored nowhere. */
export async function dumpAll(): Promise<string> {
  const out: unknown[] = [];
  for (const t of TABLES) out.push(await rows(t));
  return JSON.stringify(out);
}

/** Everything the provisioner writes to the console while `fn` runs, as one string per line. */
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
  source: 'signup' | 'added' = 'added',
): Promise<void> {
  await env.DB.prepare('INSERT INTO idp_grants (subject, source, created_at) VALUES (?, ?, ?)')
    .bind(subject, source, NOW)
    .run();
}

import { env } from 'cloudflare:workers';
import type { AuthorityError } from './authority-error.ts';
import type { Principal } from './authority-principal.ts';
import { all, first, run, type SqlValue } from './db.ts';
import type { AppError } from './errors.ts';
import { sha256Hex } from './ids.ts';

export const db = env.DB;

/** The AuthorityError code a synchronous builder call throws, or null. */
export const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (e) {
    return (e as AuthorityError).code ?? (e as Error).message;
  }
  return null;
};

/** The error a promise rejects with, or null. */
export const refusal = async (promise: Promise<unknown>): Promise<AppError | null> =>
  (await promise.then(
    () => null,
    (e: unknown) => e,
  )) as AppError | null;

export interface GateSeed {
  passId: string;
  orgId: string;
  mode?: 'live' | 'test';
  action?: string;
  scope?: string;
  state?: string;
  count?: number;
  lastAt?: number;
  lastScan?: string;
  prevScan?: string | null;
}

/** A raw scan_gates row (no grant): the fixture for tenant-guard and `when` tests. */
export async function insertGate(g: GateSeed): Promise<void> {
  await run(
    db,
    `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id, prev_scan_id)
     VALUES (?, ?, ?, ?, ?, 'tpl', 'check_in', ?, ?, 10, ?, ?, ?)`,
    [
      g.passId,
      g.action ?? 'act',
      g.scope ?? '',
      g.orgId,
      g.mode ?? 'live',
      g.state ?? 'in',
      g.count ?? 1,
      g.lastAt ?? 100,
      g.lastScan ?? 'scan-0',
      g.prevScan ?? null,
    ],
  );
}

export const gateRows = (passId: string) =>
  all<Record<string, SqlValue>>(
    db,
    'SELECT * FROM scan_gates WHERE pass_id = ? ORDER BY action_id, scope',
    [passId],
  );

export const count = async (sql: string, params: SqlValue[] = []): Promise<number> =>
  (await first<{ n: number }>(db, sql, params))?.n ?? 0;

export const noGrants = () => count('SELECT count(*) AS n FROM authority_grants');

/** A platform admin principal for `platform.*` grants. */
export async function platformPrincipal(s: {
  admin: { id: string };
  adminSession: { cookieValue: string };
}): Promise<Principal> {
  return {
    kind: 'platform',
    userId: s.admin.id,
    sessionIdHash: await sha256Hex(s.adminSession.cookieValue),
  };
}

/** The SQL and binds of one statement's EXPLAIN, with balancing off: the statement must compile on D1. */
export async function explains(sql: string, params: readonly SqlValue[]): Promise<void> {
  await db
    .prepare(`EXPLAIN ${sql}`)
    .bind(...params)
    .all();
}

/** The rows a statement returned, by its position in the commit results. */
export const resultRows = <T>(results: D1Result[], index: number): T[] =>
  (results[index]?.results ?? []) as T[];

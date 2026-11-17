import { authorityPredicate, tenantFilter } from '../../platform/authority-read.ts';
import { assertBudget, PARAM_BUDGET } from '../../platform/authority-statements.ts';
import { exactStmt, type SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { type ScanChecksInput, scanActorChecks, scanPrincipal } from './authority-checks.ts';

export interface ScanReadAuthority {
  /** CTE list to follow `WITH`: defines `actor` and `actor_ok`. */
  ctes: string;
  params: SqlValue[];
  /** The fence for the main WHERE: true only when the actor's checks all hold. */
  ok: string;
  /** Rows of `table` (aliased `alias`) belong to the actor's org and mode. */
  tenant: (alias: string, table: string) => string;
}

/**
 * The read fence for every scan read: the same principal and checks as the scan write grant, as
 * `WITH` CTEs. Use `scanRead` to run a statement under it. Throws `SCAN_EPOCHS_MISSING` for an
 * actor the guard did not capture, and `SQL_BIND_BUDGET` when the fence alone is over budget.
 */
export function scanReadAuthority(actor: ScanActor, input: ScanChecksInput): ScanReadAuthority {
  const { ctes, params } = authorityPredicate(scanPrincipal(actor), {
    scope: 'org_mode',
    now: input.now,
    checks: scanActorChecks(actor, input),
  });
  assertBudget(ctes, params, PARAM_BUDGET);
  return {
    ctes,
    params,
    ok: 'EXISTS (SELECT 1 FROM actor_ok)',
    tenant: (alias, table) => tenantFilter(alias, table, 'org_mode'),
  };
}

/**
 * Prepare `WITH <fence>[, <extra CTEs>] <sql>`. `sql` is the statement after the CTE list and
 * binds `params` in order. At most 90 binds in total, so a green test proves the statement fits D1.
 * `extra` adds CTEs (a deep witness goes in its own `MATERIALIZED` CTE, not in the main WHERE).
 */
export function scanRead(
  db: D1Database,
  auth: ScanReadAuthority,
  sql: string,
  params: readonly SqlValue[] = [],
  extra?: { ctes: string; params?: readonly SqlValue[] },
): D1PreparedStatement {
  const all = [...auth.params, ...(extra?.params ?? []), ...params];
  const text = `WITH ${auth.ctes}${extra ? `,\n${extra.ctes}` : ''}\n${sql}`;
  assertBudget(text, all, PARAM_BUDGET);
  return exactStmt(db, text, all);
}

/** `authorized` is 1 when the actor's checks all hold now. */
export const scanAuthorizedStmt = (db: D1Database, auth: ScanReadAuthority) =>
  scanRead(db, auth, `SELECT ${auth.ok} AS authorized`);

/** The fence as one scalar `EXISTS`, for a statement that cannot take a `WITH` (an `UPDATE`'s guard). */
export function scanReadFence(auth: ScanReadAuthority): { sql: string; params: SqlValue[] } {
  return { sql: `EXISTS (WITH ${auth.ctes} SELECT 1 FROM actor_ok)`, params: auth.params };
}

/** The relaxations of the scanner's own session reads (session DTO, counts, branding). */
export const SESSION_READ = {
  pausedSession: true,
  stafflessMonitor: true,
  invalidScope: true,
} as const;

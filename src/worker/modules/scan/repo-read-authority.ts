import { AuthorityError } from '../../platform/authority-error.ts';
import { authorityPredicate, tenantFilter } from '../../platform/authority-read.ts';
import { assertBudget, PARAM_BUDGET } from '../../platform/authority-statements.ts';
import { exactStmt, type SqlValue } from '../../platform/db.ts';
import { capabilityChecks } from '../passes/repo-authority.ts';
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

/** A fence that asked for read relaxations: usable by reads only, never as a write guard. */
export interface RelaxedReadAuthority extends ScanReadAuthority {
  readonly relaxed: true;
}

/** A fence with the same checks as the write grant. */
export interface StrictReadAuthority extends ScanReadAuthority {
  readonly relaxed: false;
}

/**
 * The read fence for every scan read: the same principal and checks as the scan write grant, as
 * `WITH` CTEs. Use `scanRead` to run a statement under it. Throws `SCAN_EPOCHS_MISSING` for an
 * actor the guard did not capture, and `SQL_BIND_BUDGET` when the fence alone is over budget.
 */
export function scanReadAuthority(
  actor: ScanActor,
  input: ScanChecksInput & { read: NonNullable<ScanChecksInput['read']> },
): RelaxedReadAuthority;
export function scanReadAuthority(
  actor: ScanActor,
  input: Omit<ScanChecksInput, 'read'>,
): StrictReadAuthority;
export function scanReadAuthority(actor: ScanActor, input: ScanChecksInput): ScanReadAuthority {
  const tenant = actor.tenantAuthority;
  // As `sessionGrant`: the membership's own roles still grant the capability.
  const capability = actor.principal === 'admin' && tenant ? capabilityChecks(tenant) : [];
  const { ctes, params } = authorityPredicate(scanPrincipal(actor), {
    scope: 'org_mode',
    now: input.now,
    checks: [...capability, ...scanActorChecks(actor, input)],
  });
  assertBudget(ctes, params, PARAM_BUDGET);
  return {
    ctes,
    params,
    ok: 'EXISTS (SELECT 1 FROM actor_ok)',
    tenant: (alias, table) => tenantFilter(alias, table, 'org_mode'),
    relaxed: input.read !== undefined,
  } as ScanReadAuthority;
}

/**
 * A read statement may be 64 KiB of UTF-8 (grant writes stay at 32 KiB): a history page carries
 * its flags and joins in one statement. D1 refuses 100,000 bytes, so a green corpus test proves fit.
 */
export const READ_SQL_BYTE_BUDGET = 64 * 1024;

const encoder = new TextEncoder();

/**
 * Prepare `WITH <fence>[, <extra CTEs>] <sql>`. `sql` is the statement after the CTE list and
 * binds `params` in order. At most 90 binds and 64 KiB in total, so a green test proves the
 * statement fits D1. `extra` adds CTEs (a deep witness goes in its own `MATERIALIZED` CTE, not in
 * the main WHERE).
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
  assertBudget('', all, PARAM_BUDGET);
  const bytes = encoder.encode(text).length;
  if (bytes > READ_SQL_BYTE_BUDGET)
    throw new AuthorityError(
      'SQL_SIZE_BUDGET',
      `Statement is ${bytes} bytes (limit ${READ_SQL_BYTE_BUDGET}).`,
    );
  return exactStmt(db, text, all);
}

/** `authorized` is 1 when the actor's checks all hold now. */
export const scanAuthorizedStmt = (db: D1Database, auth: ScanReadAuthority) =>
  scanRead(db, auth, `SELECT ${auth.ok} AS authorized`);

/** The fence as one scalar `EXISTS`, for a statement that cannot take a `WITH` (an `UPDATE`'s guard). */
export function scanReadFence(auth: StrictReadAuthority): { sql: string; params: SqlValue[] } {
  return { sql: `EXISTS (WITH ${auth.ctes} SELECT 1 FROM actor_ok)`, params: auth.params };
}

/** The relaxations of the scanner's own session reads (session DTO, counts, branding). */
export const SESSION_READ = {
  pausedSession: true,
  stafflessMonitor: true,
  invalidScope: true,
} as const;

/**
 * The fence of an API key's scan feed: the key is live and lists `scans:read` now. An org-bound key
 * reads its own org, which must be active. A platform key reads the org it names (suspended or not:
 * history outlives the org's access) or, naming none, every org of its mode.
 */
export function apiKeyReadAuthority(
  key: { keyId: string; orgId: string | null },
  namedOrgId: string | undefined,
  now: number,
): StrictReadAuthority {
  const bound = key.orgId !== null;
  const { ctes, params } = authorityPredicate(
    {
      kind: 'api_key',
      keyId: key.keyId,
      scope: 'scans:read',
      ...(typeof key.orgId === 'string' ? { orgId: key.orgId } : {}),
    },
    { scope: bound ? 'org_mode' : 'platform', now },
  );
  assertBudget(ctes, params, PARAM_BUDGET);
  const named = !bound && namedOrgId !== undefined;
  return {
    ctes: named ? `${ctes},\n    named AS MATERIALIZED (SELECT ? AS org_id)` : ctes,
    params: named ? [...params, namedOrgId] : params,
    ok: 'EXISTS (SELECT 1 FROM actor_ok)',
    tenant: (alias, table) =>
      bound
        ? tenantFilter(alias, table, 'org_mode')
        : `${named ? `${alias}.org_id = (SELECT org_id FROM named) AND ` : ''}${alias}.mode = (SELECT mode FROM actor_ok)`,
    relaxed: false,
  };
}

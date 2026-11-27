import type { Check } from './authority-checks.ts';
import { AuthorityError } from './authority-error.ts';
import {
  actorSql,
  assertNoInactiveOk,
  Binds,
  type GrantScope,
  type Principal,
} from './authority-principal.ts';
import { hasTemplateRef, type KeyRef, restrictRow } from './authority-restrict.ts';
import { GUARDED_TABLES } from './authority-tables.ts';
import type { SqlValue } from './db.ts';

/** The stamped name of the presence column (`check:rules` refuses the literal outside the guard files). */
export const PRESENT = 'ao.authority_present_k7';
// "\xFFabsent": invalid UTF-8, so no stored TEXT, BLOB or INTEGER value is `=`, `IN` or `IS` to it.
const ABSENT = "CAST(X'FF616273656E74' AS TEXT)";
const col = (name: string) => `IIF(count(*) = 1, max(${name}), ${ABSENT}) AS ${name}`;
/** First FROM term of a row read: no actor, no rows. */
export const ROWS = 'actor_ok ao CROSS JOIN ';
/** `FROM actor_ok ao` alone, directly followed by WHERE, `)` or the end. */
export const ROWS_ALONE = 'actor_ok ao';
/** One row always. Absent: present 0 and the sentinel in the three columns; present: its own values, NULLs kept. */
export const ANCHOR = `(SELECT count(*) AS authority_present_k7, ${col('org_id')}, ${col('mode')}, ${col('limit_key')} FROM actor_ok) AS ao`;

export interface AuthorityPredicate {
  /** CTE list to follow `WITH`. Defines `actor` and `actor_ok` (one row of org_id, mode, limit_key, present when allowed). */
  ctes: string;
  params: SqlValue[];
  /** First FROM term of a row read: `actor_ok ao CROSS JOIN ` (prefix the first table). No actor, no rows. */
  rows: string;
  /** Outermost FROM of a statement that must return one row when the actor fails: `ao.org_id` etc. are then a sentinel no stored value equals. */
  anchor: string;
  /** The actor's checks all hold. Presence is never inferred from `ao.org_id IS NULL` (a platform key has no org). */
  ok: string;
  /** A platform key's tenant: present and org-less (`ao.org_id` is a sentinel, not NULL, when absent). */
  platform: string;
  /** `CASE WHEN <ok> THEN 1 ELSE 0 END AS alias`: the one output form of presence. Top-level select list only. */
  authorized: (alias: string, cond?: string) => string;
  /** The tenant predicate, written against the one `ao` row; fails to prepare without the join. */
  tenant: (alias: string, table: string, scope?: Exclude<GrantScope, 'platform'>) => string;
}

/**
 * Read authority: the grant's checks without the insert (section 1.4). Reads never write a grant.
 * Use as `WITH ${ctes} SELECT ... FROM ${rows}<first table> WHERE ${tenant(...)}`: `actor_ok` is expanded once, as
 * the statement's outermost FROM (`assertActorOnce`), and the tenant comes from its row `ao`, never from the request.
 */
export function authorityPredicate(
  principal: Principal,
  options: { scope: GrantScope; now: number; checks?: Check[] },
): AuthorityPredicate {
  assertNoInactiveOk(principal);
  const b = new Binds(principal.kind === 'api_key');
  const actor = actorSql(principal, options.now, b);
  const checks = (options.checks ?? []).map((c) => `COALESCE((${c.ok(b, options.scope)}), 0) = 1`);
  const tenant = options.scope === 'platform' ? '' : ' AND a.org_id IS NOT NULL';
  const ok = ['a.actor_ok = 1', 'a.org_ok = 1', ...checks].join(' AND ');
  const ctes = `actor AS MATERIALIZED (${actor}),
    actor_ok AS MATERIALIZED (SELECT 1 AS authority_present_k7, a.org_id AS org_id, a.mode AS mode, a.limit_key AS limit_key FROM actor a WHERE ${ok}${tenant})`;
  return {
    ctes,
    params: b.params,
    rows: ROWS,
    anchor: ANCHOR,
    ok: `${PRESENT} = 1`,
    platform: 'ao.org_id IS NULL',
    authorized: (alias, cond) =>
      `CASE WHEN ${PRESENT} = 1${cond ? ` AND (${cond})` : ''} THEN 1 ELSE 0 END AS ${alias}`,
    tenant: (alias, table, scope = 'org_mode') =>
      tenantBody(alias, table, scope, {
        org: 'ao.org_id',
        mode: 'ao.mode',
        key: 'ao.limit_key',
      }),
  };
}

/**
 * The tenant predicate of a read: `alias` rows belong to the actor's org (and mode, for `org_mode`), taken from
 * `ao`, never from the request. For a key limited to templates or styles they also belong to one of its templates
 * (none of a table with no template dimension).
 */
function tenantBody(
  alias: string,
  table: string,
  scope: Exclude<GrantScope, 'platform'>,
  at: { org: string; mode: string; key: KeyRef },
): string {
  const t = GUARDED_TABLES[table];
  if (!t || t.org === null)
    throw new AuthorityError('GRANT_UNGUARDED_TABLE', `${table} has no org column to filter.`);
  const own =
    t.org === 'scope' ? `${alias}.scope = 'org:' || ${at.org}` : `${alias}.${t.org} = ${at.org}`;
  const tenant = scope === 'org_mode' && t.mode ? `${own} AND ${alias}.mode = ${at.mode}` : own;
  // Keep `own` first: the list form is vacuous for an empty key list.
  // A key limited to templates reads only rows of its templates, and none of a table with no template dimension.
  return hasTemplateRef(table)
    ? `${tenant}${restrictRow(table, alias, at.key)}`
    : `${tenant} AND ${at.key} IS NULL`;
}

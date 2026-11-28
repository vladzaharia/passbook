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

export interface AuthorityPredicate {
  /** CTE list to follow `WITH`. Defines `actor` and `actor_ok` (one row of org_id, mode, limit_key, present when allowed). */
  ctes: string;
  params: SqlValue[];
  /** First FROM term of a row read: `actor_ok ao CROSS JOIN ` (prefix the first table). No actor, no rows. */
  rows: string;
  /** Outermost FROM of a statement that must return one row when the actor fails: `ao` columns are then NULL. */
  anchor: string;
  /** The actor's checks all hold. Presence is never inferred from `ao.org_id IS NULL` (a platform key has no org). */
  ok: string;
  /** A platform key's tenant: present and org-less. Never write `ao.org_id IS NULL` alone (an absent anchor row is NULL too). */
  platform: string;
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
    actor_ok AS MATERIALIZED (SELECT 1 AS present, a.org_id AS org_id, a.mode AS mode, a.limit_key AS limit_key FROM actor a WHERE ${ok}${tenant})`;
  return {
    ctes,
    params: b.params,
    rows: 'actor_ok ao CROSS JOIN ',
    anchor: '(SELECT 1 AS one) AS one LEFT JOIN actor_ok ao ON 1 = 1',
    ok: 'ao.present = 1',
    platform: 'ao.present = 1 AND ao.org_id IS NULL',
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
  // Never emit the key term without `own` first: an absent anchor row makes `ao.limit_key IS NULL` true.
  // A key limited to templates reads only rows of its templates, and none of a table with no template dimension.
  return hasTemplateRef(table)
    ? `${tenant}${restrictRow(table, alias, at.key)}`
    : `${tenant} AND ${at.key} IS NULL`;
}

import type { Check } from './authority-checks.ts';
import { AuthorityError } from './authority-error.ts';
import { actorSql, Binds, type GrantScope, type Principal } from './authority-principal.ts';
import { GUARDED_TABLES } from './authority-tables.ts';
import type { SqlValue } from './db.ts';

export interface AuthorityPredicate {
  /** CTE list to follow `WITH`. Defines `actor` and `actor_ok` (one row of org_id, mode when allowed). */
  ctes: string;
  params: SqlValue[];
}

/**
 * Read authority: the grant's checks without the insert (section 1.4). Reads never write a grant.
 * Use as `WITH ${ctes} SELECT ... WHERE EXISTS (SELECT 1 FROM actor_ok)`; join `actor_ok` to take
 * the tenant from it instead of from the request.
 */
export function authorityPredicate(
  principal: Principal,
  options: { scope: GrantScope; now: number; checks?: Check[] },
): AuthorityPredicate {
  const b = new Binds();
  const actor = actorSql(principal, options.now, b);
  const checks = (options.checks ?? []).map((c) => `COALESCE((${c.ok(b, options.scope)}), 0) = 1`);
  const tenant = options.scope === 'platform' ? '' : ' AND a.org_id IS NOT NULL';
  const ok = ['a.actor_ok = 1', 'a.org_ok = 1', ...checks].join(' AND ');
  const ctes = `actor AS MATERIALIZED (${actor}),
    actor_ok AS MATERIALIZED (SELECT a.org_id AS org_id, a.mode AS mode FROM actor a WHERE ${ok}${tenant})`;
  return { ctes, params: b.params };
}

/**
 * The tenant predicate of a read: `alias` rows belong to the actor's org (and mode, for `org_mode`),
 * taken from the `actor_ok` CTE of `authorityPredicate`, never from the request. A read that joins
 * `actor_ok` but forgets this still sees other tenants' rows; WP7's corpus test requires it.
 */
export function tenantFilter(
  alias: string,
  table: string,
  scope: Exclude<GrantScope, 'platform'> = 'org_mode',
): string {
  const t = GUARDED_TABLES[table];
  if (!t || t.org === null)
    throw new AuthorityError('GRANT_UNGUARDED_TABLE', `${table} has no org column to filter.`);
  const org = '(SELECT org_id FROM actor_ok)';
  const own =
    t.org === 'scope' ? `${alias}.scope = 'org:' || ${org}` : `${alias}.${t.org} = ${org}`;
  return scope === 'org_mode' && t.mode
    ? `${own} AND ${alias}.mode = (SELECT mode FROM actor_ok)`
    : own;
}

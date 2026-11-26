// Grant checks over the org's entitlements (design-multi-tenancy.md section 2.3). The one lookup is the
// `org_entitlement_values` view for the actor's org. Every check fails closed: a missing row, an invalid
// value or a NULL denies; only JSON `null` on a limit means "no limit".
import {
  type EntitlementKey,
  entitlementDef,
  entitlementJson,
  levelsAtLeast,
  listMatches,
} from '../../shared/contracts/entitlements.ts';
import type { Check } from './authority-checks.ts';
import { tenantSql } from './authority-cond.ts';
import { AuthorityError } from './authority-error.ts';
import {
  actorSql,
  assertNoInactiveOk,
  Binds,
  type GrantScope,
  type Principal,
} from './authority-principal.ts';
import type { SqlValue } from './db.ts';
import type { LimitHit } from './errors.ts';

const bad = (message: string) => new AuthorityError('GRANT_BAD_PURPOSE', message);

function needOrg(scope: GrantScope): void {
  if (scope === 'platform')
    throw new AuthorityError(
      'GRANT_SCOPE_OVERRIDE',
      'An entitlement check needs a tenant: a platform grant has none.',
    );
}

/** `SELECT <expr> FROM org_entitlement_values v WHERE v.org_id = a.org_id AND v.key = ?`; no row is NULL. */
const lookup = (b: Binds, key: EntitlementKey, expr: (v: string) => string): string => {
  // Binds are positional: the expression's binds come first, the key's last.
  const sql = expr('ent_v.value');
  return `(SELECT ${sql} FROM org_entitlement_values ent_v WHERE ent_v.org_id = a.org_id AND ent_v.key = ${b.bind(key)})`;
};

/**
 * The org may use `key`. A flag must be 1. A level must be at least `want`. A list: `want` is the item,
 * which an allow-list must name (`*`, the item or `type/*`) and a block-list must not. A limit is on unless
 * it is 0 (`null` has no cap). Reason `entitlement`.
 */
export function entitled(key: EntitlementKey, want?: string): Check {
  const def = entitlementDef(key);
  const items = want === undefined ? [] : listMatches(want);
  const levels = want === undefined ? [] : levelsAtLeast(key, want);
  if (def.kind === 'level' && levels.length === 0)
    throw bad(`entitled(${key}) needs a level of ${def.levels.join(', ')}.`);
  if (def.kind === 'list' && (want === undefined || want.includes('*')))
    throw bad(`entitled(${key}) needs an item, not a pattern.`);
  return {
    reason: 'entitlement',
    ok: (b, scope) => {
      needOrg(scope);
      switch (def.kind) {
        case 'flag':
          return lookup(b, key, (v) => `${v} = ${b.bind(entitlementJson(1))}`);
        case 'level': {
          const marks = levels.map((l) => b.bind(entitlementJson(l))).join(', ');
          return lookup(b, key, (v) => `${v} IN (${marks})`);
        }
        case 'list': {
          const marks = items.map((m) => b.bind(m)).join(', ');
          const hit = (v: string) =>
            `EXISTS (SELECT 1 FROM json_each(${v}) ent_j WHERE ent_j.value IN (${marks}))`;
          return lookup(
            b,
            key,
            (v) => `json_type(${v}) = 'array' AND ${def.block ? 'NOT ' : ''}${hit(v)}`,
          );
        }
        case 'limit':
          return lookup(
            b,
            key,
            (v) =>
              `CASE json_type(${v}) WHEN 'null' THEN 1 WHEN 'integer' THEN CAST(${v} AS INTEGER) > 0 ELSE 0 END`,
          );
      }
    },
  };
}

/**
 * One more fits under the limit `key`: `countSql` (a `tenantSql` count of what the org holds now, with
 * `{org}` and `{mode}`) is below the cap. Evaluated in the grant insert, the first statement of a D1
 * batch, and D1 runs batches one at a time, so two creates at n-1 cannot both pass. Reason `limit`.
 */
export function withinLimit(
  key: EntitlementKey,
  countSql: string,
  params: readonly SqlValue[] = [],
): Check {
  if (entitlementDef(key).kind !== 'limit') throw bad(`withinLimit(${key}) needs a limit.`);
  const count = tenantSql(countSql, params);
  return {
    reason: 'limit',
    limit: { key, count },
    ok: (b, scope) => {
      needOrg(scope);
      // The count's binds come first in the text; lookup() binds the key after them.
      const counted = count.render(b, scope, 'a');
      return lookup(
        b,
        key,
        (v) =>
          `CASE json_type(${v}) WHEN 'null' THEN 1 WHEN 'integer' THEN (${counted}) < CAST(${v} AS INTEGER) ELSE 0 END`,
      );
    },
  };
}

/**
 * After a `limit` refusal: the first limit check of a grant whose cap the org has reached, with its cap and
 * count. Read through the grant's own actor row, so it names the same org and mode the refusal judged; it
 * is a diagnosis, so a count that moved since is reported as read. Null when none reads as reached.
 */
export async function limitHitOf(
  db: D1Database,
  scope: GrantScope,
  principal: Principal,
  now: number,
  checks: readonly Check[],
): Promise<LimitHit | null> {
  for (const check of checks) {
    if (!check.limit) continue;
    assertNoInactiveOk(principal);
    const b = new Binds();
    const actor = actorSql(principal, now, b);
    const key = b.bind(check.limit.key);
    const sql = `WITH actor AS MATERIALIZED (${actor})
      SELECT (SELECT ent_v.value FROM org_entitlement_values ent_v
          WHERE ent_v.org_id = a.org_id AND ent_v.key = ${key}) AS value,
        (${check.limit.count.render(b, scope, 'a')}) AS used,
        (SELECT o.kind = 'developer' FROM orgs o WHERE o.id = a.org_id) AS sandbox
      FROM actor a`;
    const row = await db
      .prepare(sql)
      .bind(...b.params)
      .first<{ value: string | null; used: number | null; sandbox: number | null }>();
    const max = row?.value == null ? Number.NaN : Number(row.value);
    if (!Number.isInteger(max) || row?.used == null || row.used < max) continue;
    return {
      key: check.limit.key,
      limit: max,
      used: row.used,
      ...(row.sandbox ? { sandbox: true as const } : {}),
    };
  }
  return null;
}

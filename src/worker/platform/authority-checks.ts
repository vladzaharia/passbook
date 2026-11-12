import { AuthorityError } from './authority-error.ts';
import { identifier, renderCond, type WhereValue } from './authority-expr.ts';
import { type Binds, type GrantScope, LEGACY_REVISION_MS } from './authority-principal.ts';
import { assertPlainParams, assertSqlText } from './authority-sqltext.ts';
import { GUARDED_TABLES, ownedColumns } from './authority-tables.ts';
import type { SqlValue } from './db.ts';
import type { DenyReason } from './errors.ts';

/**
 * One condition evaluated inside the grant insert, over the resolved actor row `a`. `ok` returns a SQL
 * boolean; a NULL counts as a refusal. Checks never carry an org or mode from the request: tenant
 * columns are compared with `a.org_id` and `a.mode`.
 */
export interface Check {
  reason: DenyReason;
  ok(b: Binds, scope: GrantScope): string;
}

/** The target row belongs to the tenant of `t`: the actor row `a`, or a grant row `g`. */
export function tenantMatch(
  table: string,
  alias: string,
  scope: GrantScope,
  tenant: 'a' | 'g' = 'a',
): string {
  const t = GUARDED_TABLES[table];
  if (!t || t.org === null)
    throw new AuthorityError('GRANT_UNGUARDED_TABLE', `Table ${table} has no org column to check.`);
  if (scope === 'platform') return '1 = 1';
  const org =
    t.org === 'scope'
      ? `${alias}.scope = 'org:' || ${tenant}.org_id`
      : `${alias}.${t.org === 'id' ? 'id' : t.org} = ${tenant}.org_id`;
  return scope === 'org_mode' && t.mode ? `${org} AND ${alias}.mode = ${tenant}.mode` : org;
}

/** A check may narrow a row by its own columns, never by the tenant columns the grant owns. */
export function rejectOwnedConditions(table: string, scope: GrantScope, keys: string[]): void {
  const t = GUARDED_TABLES[table];
  const owned = t ? ownedColumns(t, scope) : new Set<string>();
  for (const key of keys)
    if (owned.has(identifier(key)))
      throw new AuthorityError(
        'GRANT_SCOPE_OVERRIDE',
        `A check cannot name ${key}: the grant supplies it.`,
      );
}

/**
 * Exactly one row of `table` matches `where` inside the tenant (a child is reached through its
 * `edge` column). Evaluated in the grant insert, against the state before the batch's writes.
 */
export function exactlyOne(
  table: string,
  where: Record<string, WhereValue>,
  edge?: string,
  reason: DenyReason = 'lineage',
): Check {
  identifier(table);
  return {
    reason,
    ok: (b, scope) => {
      const t = GUARDED_TABLES[table];
      if (!t) throw new AuthorityError('GRANT_UNGUARDED_TABLE', `${table} is not a guarded table.`);
      const local: SqlValue[] = [];
      const conds = Object.entries(where).map(([c, v]) => renderCond('t.', c, v, local));
      let from = `${table} t`;
      let tenant = '1 = 1';
      if (t.org === null) {
        const e = t.edges?.find((x) => x.column === edge);
        if (e) {
          from = `${table} t JOIN ${e.parent} p ON p.${e.key} = t.${e.column}`;
          tenant = tenantMatch(e.parent, 'p', scope);
        }
      } else {
        rejectOwnedConditions(table, scope, Object.keys(where));
        tenant = tenantMatch(table, 't', scope);
      }
      for (const v of local) b.bind(v);
      return `(SELECT count(*) FROM ${from} WHERE ${[...conds, tenant].join(' AND ')}) = 1`;
    },
  };
}

/** A row of `table` with this id exists in the actor's tenant and has these column values. */
export function rowIs(
  table: string,
  id: string,
  conditions: Record<string, SqlValue> = {},
  reason: DenyReason = 'lineage',
): Check {
  identifier(table);
  return {
    reason,
    ok: (b, scope) => {
      rejectOwnedConditions(table, scope, Object.keys(conditions));
      const key = GUARDED_TABLES[table]?.org === 'scope' ? 'scope' : 'id';
      const target = `t.${key} = ${b.bind(id)}`;
      const extra = Object.entries(conditions).map(([column, value]) =>
        value === null
          ? `t.${identifier(column)} IS NULL`
          : `t.${identifier(column)} = ${b.bind(value)}`,
      );
      return `EXISTS (SELECT 1 FROM ${table} t WHERE ${target} AND ${tenantMatch(table, 't', scope)}${extra.map((e) => ` AND ${e}`).join('')})`;
    },
  };
}

/** The pass exists in the tenant (lineage) and, when given, still has the row_version the caller read (stale). */
export function passRow(id: string, rowVersion?: number): Check[] {
  const checks = [rowIs('passes', id)];
  if (rowVersion !== undefined)
    checks.push(rowIs('passes', id, { row_version: rowVersion }, 'stale'));
  return checks;
}

/** The org's access_revision is still the one captured when the work was queued. */
export function orgRevision(revision: number): Check {
  return {
    reason: 'org',
    // A legacy `updated_at` (ms) from pre-cutover work is accepted on org status, which the actor row checks.
    ok: (b) =>
      revision >= LEGACY_REVISION_MS
        ? '1 = 1'
        : `(SELECT access_revision FROM orgs WHERE id = a.org_id) = ${b.bind(revision)}`,
  };
}

/** A row's epoch column still equals the value the caller captured. */
export function epochIs(
  table: string,
  id: string,
  column: string,
  value: number,
  reason: DenyReason = 'config',
): Check {
  return rowIs(table, id, { [identifier(column)]: value }, reason);
}

/**
 * The release is the current head for (template, mode, provider), read from `template_release_heads`: the
 * org's own head wins (for a baked template only when it is assigned to that org), and the platform head
 * counts only for an unassigned baked template. Releases are immutable and ordered by `generation`. Under an
 * `org_mode` grant the mode must equal the grant's mode. It checks headship and the template's status and
 * ownership only: callers take `releaseId` from `effectiveReleaseIdSql` / `activeRelease` in the same request, which
 * also applies the legacy `active_version`, policy and content-hash rules. WP-T's `effectiveReleaseIdSql` applies the same
 * precedence to the SQL reads (templates/repo-release-heads.ts).
 */
export function releaseHead(
  templateId: string,
  mode: string,
  provider: string,
  releaseId: string,
): Check {
  return {
    reason: 'release',
    ok: (b, scope) => {
      const head = (guard: string, orgScope: string) =>
        `(SELECT h.id FROM template_releases h JOIN templates t ON t.id = h.template_id
          WHERE t.id = ${b.bind(templateId)} AND h.mode = ${b.bind(mode)} AND h.provider = ${b.bind(provider)}
            AND ${orgScope} AND ${guard} ORDER BY h.generation DESC LIMIT 1)`;
      const org = head(
        "t.status = 'active' AND (t.origin = 'uploaded' AND (t.org_id IS NULL OR t.org_id = a.org_id) OR t.origin = 'baked' AND t.org_id = a.org_id)",
        'h.org_id = a.org_id',
      );
      const platform = head(
        "t.status = 'active' AND t.origin = 'baked' AND t.org_id IS NULL",
        'h.org_id IS NULL',
      );
      const eq = `COALESCE(${org}, ${platform}) = ${b.bind(releaseId)}`;
      return scope === 'org_mode' ? `${eq} AND ${b.bind(mode)} = a.mode` : eq;
    },
  };
}

/**
 * The template has no release head in this scope: neither an org head for (template, mode, provider) nor the
 * platform head of an unassigned baked template. The precondition of publishing a legacy template that has
 * no history. Stricter than "no effective head": an org row of a reassigned baked template still refuses.
 */
export function noReleaseHead(templateId: string, provider = 'apple'): Check {
  return {
    reason: 'release',
    ok: (b, scope) => {
      if (scope !== 'org_mode')
        throw new AuthorityError('GRANT_SCOPE_OVERRIDE', 'noReleaseHead needs an org_mode grant.');
      return `NOT EXISTS (SELECT 1 FROM template_releases h WHERE h.template_id = ${b.bind(templateId)}
          AND h.org_id = a.org_id AND h.mode = a.mode AND h.provider = ${b.bind(provider)})
        AND NOT EXISTS (SELECT 1 FROM template_releases h JOIN templates t ON t.id = h.template_id
          WHERE h.template_id = ${b.bind(templateId)} AND h.org_id IS NULL AND h.mode = a.mode
            AND h.provider = ${b.bind(provider)} AND t.origin = 'baked' AND t.org_id IS NULL)`;
    },
  };
}

const RAW_FORBIDDEN =
  /\b(?:org_id|mode|scope)\b|;|--|\/\*|\b(?:insert|update|delete|replace|attach|pragma|drop|create|alter)\b/i;

/**
 * Escape hatch for a package-specific read-only condition. SQL is fixed text; every value is bound.
 * It cannot name the tenant columns (`org_id`, `mode`, `scope`; the actor row `a` carries them), so it
 * cannot narrow to a request-chosen tenant, and it cannot hold a second statement or a write. `a` is the
 * actor row: an inner alias `a` would shadow it. A positive EXISTS over a tenant table needs a tenant term,
 * so it is a `tenantCheck` (`tools/authority-scope.ts` rule `untenanted-check`).
 */
export function rawCheck(reason: DenyReason, sql: string, params: readonly SqlValue[] = []): Check {
  return {
    reason,
    ok: (b) => {
      const text = assertSqlText(sql, 'A raw grant check');
      assertPlainParams(text, 'A raw grant check');
      if (RAW_FORBIDDEN.test(sql.replace(/\ba\.(?:org_id|mode)\b/g, 'a_')))
        throw new AuthorityError(
          'GRANT_SCOPE_OVERRIDE',
          'A raw grant check is read-only and cannot name an org, mode or scope column.',
        );
      if (/\ba\b/i.test(text.replace(/\ba\.(?:org_id|mode)\b/g, ' ')))
        throw new AuthorityError(
          'GRANT_SCOPE_OVERRIDE',
          'The alias a is reserved in a raw grant check: it is the actor row.',
        );
      let i = 0;
      const out = sql.replace(/\?/g, () => b.bind(params[i++]));
      if (i !== params.length) throw new Error('rawCheck parameter count mismatch');
      return out;
    },
  };
}

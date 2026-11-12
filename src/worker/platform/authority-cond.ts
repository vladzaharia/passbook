// Read-only row conditions over the grant's tenant (`when`, assert, `condCheck`). Contract:
// builder-ext design sections 1.B and 1.D. A condition only narrows what a statement does.
import { type Check, rejectOwnedConditions, tenantMatch } from './authority-checks.ts';
import { AuthorityError } from './authority-error.ts';
import { identifier, renderCond, type WhereValue } from './authority-expr.ts';
import { Binds, type GrantScope } from './authority-principal.ts';
import {
  assertPlainParams,
  assertSqlText,
  assertTenantConjuncts,
  mapOutsideLiterals,
} from './authority-sqltext.ts';
import { GUARDED_TABLES } from './authority-tables.ts';
import type { SqlValue } from './db.ts';
import { DENY_REASONS, type DenyReason } from './errors.ts';

/**
 * A read-only SQL boolean over the tenant. `t` is `a` (the actor row, in the grant insert) or `g` (the
 * grant row, inside a statement). `row` names the written table for a `{row}` reference (update, delete,
 * joined `when` only).
 */
export interface GrantCond {
  render(b: Binds, scope: GrantScope, t: 'a' | 'g', row?: string): string;
}

const override = (message: string) => new AuthorityError('GRANT_SCOPE_OVERRIDE', message);

function existsCond(
  table: string,
  where: Record<string, WhereValue>,
  negate: boolean,
  via?: string,
): GrantCond {
  const t = GUARDED_TABLES[identifier(table)];
  const edge =
    t?.org === null
      ? via === undefined
        ? t.edges?.[0]
        : t.edges?.find((e) => e.column === via)
      : undefined;
  if (!t || (t.org === null && !edge))
    throw new AuthorityError(
      'GRANT_NO_EDGE',
      `${table} has no org column or declared edge to test.`,
    );
  const entries = Object.entries(where);
  if (entries.length === 0)
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'exists() needs a where clause.');
  return {
    render: (b, scope, tenant) => {
      rejectOwnedConditions(
        table,
        scope,
        entries.map(([k]) => k),
      );
      const local: SqlValue[] = [];
      const conds = entries.map(([c, v]) => renderCond('x.', c, v, local));
      for (const v of local) b.bind(v);
      // An org-less child is reached through its declared edge: the parent row carries the tenant.
      const from = edge
        ? `${table} x JOIN ${edge.parent} p ON p.${edge.key} = x.${edge.column}`
        : `${table} x`;
      const own = edge
        ? tenantMatch(edge.parent, 'p', scope, tenant)
        : tenantMatch(table, 'x', scope, tenant);
      return `${negate ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${from} WHERE ${[...conds, own].join(' AND ')})`;
    },
  };
}

/** A row of `table` in the grant's tenant matches `where`. */
export const exists = (table: string, where: Record<string, WhereValue>, via?: string): GrantCond =>
  existsCond(table, where, false, via);
/** No row of `table` in the grant's tenant matches `where`. */
export const notExists = (
  table: string,
  where: Record<string, WhereValue>,
  via?: string,
): GrantCond => existsCond(table, where, true, via);
/** Logical NOT; a NULL condition counts as false, so its negation is true. */
export const not = (cond: GrantCond): GrantCond => ({
  render: (b, scope, t, row) => `NOT COALESCE((${cond.render(b, scope, t, row)}), 0)`,
});

const FORBIDDEN = /;|--|\/\*|\b(?:insert|update|delete|replace|attach|pragma|drop|create|alter)\b/i;
const TENANT_FORMS = [
  /\b\w+\.org_id\s*=\s*\{org\}/g,
  /\{org\}\s*=\s*\w+\.org_id\b/g,
  /\b\w+\.mode\s*=\s*\{mode\}/g,
  /\{mode\}\s*=\s*\w+\.mode\b/g,
  /\b\w+\.org_id\s+IS\s+NULL\b/gi,
];

const CMP = /^\s*(?:==?|is\b|in\b|!=|<>)\s*\(?\s*\?/i;

/** A JSON field compared to a bound value is a request-chosen tenant read through the data column. */
function refuseBoundJson(text: string): void {
  const bad = () => override('A tenant condition cannot compare a JSON field to a bound value.');
  if (/->>?\s*(?:''|\?)\s*(?:==?|is\b|in\b|!=|<>)\s*\(?\s*\?/i.test(text)) throw bad();
  for (const m of text.matchAll(/\bjson_extract\s*\(/gi)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    for (; i < text.length && depth > 0; i++)
      depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
    if (CMP.test(text.slice(i))) throw bad();
    const before = text.slice(0, m.index ?? 0);
    if (/\?\s*(?:==?|is\b|!=|<>)\s*$/i.test(before)) throw bad();
  }
}

/** Fixed-text lint for `tenantSql`. Throws GRANT_SCOPE_OVERRIDE; returns the `?` count. */
function lintTenantSql(sql: string): { questions: number; marks: Set<string> } {
  const text = assertSqlText(sql, 'A tenant condition');
  if (/\b(?:orgs|natural|using)\b/i.test(text))
    throw override('A tenant condition cannot read orgs or use NATURAL or USING joins.');
  if (
    /\{(?:org|mode)\}\s*(?:==?|is|in|!=|<>)\s*\(?\s*\?|\?\s*\)?\s*(?:==?|is|!=|<>)\s*\{(?:org|mode)\}/i.test(
      text,
    )
  )
    throw override('{org} and {mode} are not compared to a bound value.');
  refuseBoundJson(text);
  if (FORBIDDEN.test(text))
    throw override('A tenant condition is read-only fixed SQL: no writes, `;` or comments.');
  if (/\{row\}\s*\.\s*(?:org_id|mode)\b/.test(text))
    throw override('{row} cannot reach org_id or mode: compare them to {org} and {mode}.');
  // `a` and `g` are the actor and grant rows the markers render to; an inner alias would shadow them.
  if (/\b[ag]\b/i.test(text))
    throw override('The aliases a and g are reserved in a tenant condition.');
  assertPlainParams(text, 'A tenant condition');
  assertTenantConjuncts(text, 'A tenant condition');
  const marks = new Set([...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? ''));
  let rest = text;
  for (const form of TENANT_FORMS) rest = rest.replace(form, ' ');
  for (const m of marks)
    if (m !== 'org' && m !== 'mode' && m !== 'row') throw override(`Unknown marker {${m}}.`);
  rest = rest.replace(/\{(?:org|mode|row)\}/g, ' ');
  if (/\b(?:org_id|mode)\b/i.test(rest))
    throw override('A tenant condition compares org_id and mode only to {org} and {mode}.');
  if (/\bscope\b/i.test(rest) && /\bsettings\b/i.test(rest))
    throw override('A tenant condition cannot read settings.scope.');
  return { questions: [...text.matchAll(/\?/g)].length, marks };
}

/**
 * Read-only SQL that may compare a row to the grant's tenant through `{org}` and `{mode}`, and (in a
 * `when` on update, delete or joined) read the written row through `{row}`. Binds `?` in text order. A
 * lint over fixed text, like `rawCheck`: it refuses request-chosen tenants, not hostile code.
 */
export function tenantSql(sql: string, params: readonly SqlValue[] = []): GrantCond {
  const { questions, marks } = lintTenantSql(sql);
  if (questions !== params.length) throw new Error('tenantSql parameter count mismatch');
  return {
    render: (b, scope, t, row) => {
      if (marks.has('row') && (t === 'a' || row === undefined))
        throw override('{row} is allowed only in a when on update, delete or joined.');
      const rowOrg = row === undefined ? undefined : GUARDED_TABLES[row]?.org;
      if (rowOrg && new RegExp(`\\{row\\}\\s*\\.\\s*${rowOrg}\\b`).test(sql))
        throw override(`{row}.${rowOrg} is the tenant column of ${row}.`);
      if (marks.has('org') && scope === 'platform')
        throw override('{org} needs a tenant: a platform grant has none.');
      if (marks.has('mode') && scope !== 'org_mode')
        throw override('{mode} needs an org_mode grant.');
      let i = 0;
      return mapOutsideLiterals(sql, (seg) =>
        seg.replace(/\?|\{(org|mode|row)\}/g, (m, name?: string) => {
          if (m === '?') return b.bind(params[i++] ?? null);
          return name === 'row' ? (row ?? '') : `${t}.${name === 'org' ? 'org_id' : 'mode'}`;
        }),
      );
    },
  };
}

/** A check that every condition holds, evaluated in the grant insert over the actor row. */
export function condCheck(reason: DenyReason, ...conds: GrantCond[]): Check {
  if (conds.length === 0)
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'condCheck needs a condition.');
  return {
    reason,
    ok: (b, scope) => conds.map((c) => `(${c.render(b, scope, 'a')})`).join(' AND '),
  };
}

/** `tenantSql` as a check: `{org}` and `{mode}` render to the actor row. `{row}` is refused. */
export const tenantCheck = (
  reason: DenyReason,
  sql: string,
  params: readonly SqlValue[] = [],
): Check => condCheck(reason, tenantSql(sql, params));

/** ` AND (c1) AND (c2)` for a statement `when`, binding into `params` in text order. */
export function whenSql(
  when: readonly GrantCond[] | undefined,
  scope: GrantScope,
  params: SqlValue[],
  row?: string,
): string {
  if (!when || when.length === 0) return '';
  const b = new Binds();
  const sql = when.map((c) => ` AND (${c.render(b, scope, 'g', row)})`).join('');
  params.push(...b.params);
  return sql;
}

/**
 * A grant-shaped row that carries `denied`: the deny trigger aborts the batch with
 * `authority_denied:<reason>` when a condition fails at this point, and nothing is inserted otherwise.
 */
export function buildAssert(
  grantId: string,
  scope: GrantScope,
  reason: DenyReason,
  conds: readonly GrantCond[],
  when?: readonly GrantCond[],
): { sql: string; params: SqlValue[] } {
  if (!DENY_REASONS.includes(reason))
    throw new AuthorityError('GRANT_BAD_PURPOSE', `Unknown refusal reason: ${reason}`);
  if (conds.length === 0)
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'An assert needs a condition.');
  const params: SqlValue[] = [reason, grantId];
  const gate = whenSql(when, scope, params);
  const b = new Binds();
  const holds = conds.map((c) => `COALESCE((${c.render(b, scope, 'g')}), 0) = 1`).join(' AND ');
  params.push(...b.params);
  return {
    sql: `INSERT INTO authority_grants (id, scope, org_id, mode, principal, purpose, target_id, denied, created_at, leak_guard)
      SELECT g.id || ':assert', g.scope, g.org_id, g.mode, g.principal, g.purpose, g.target_id, ?, g.created_at, g.id || ':assert'
      FROM authority_grants g WHERE g.id = ?${gate} AND NOT (${holds})`,
    params,
  };
}

import { type Check, exactlyOne } from './authority-checks.ts';
import { type GrantCond, whenSql } from './authority-cond.ts';
import { AuthorityError } from './authority-error.ts';
import {
  identifier,
  renderCond,
  renderSet,
  type SetValue,
  type WhereValue,
} from './authority-expr.ts';
import { holderTable, pinPredicate, pinWhere } from './authority-pin.ts';
import type { GrantScope } from './authority-principal.ts';
import { keyedSet, restrictRow } from './authority-restrict.ts';
import { epochColumns, GUARDED_TABLES, ownedColumns, type TableScope } from './authority-tables.ts';
import type { SqlValue } from './db.ts';

export const WRITE_PARAM_BUDGET = 40;
export const PARAM_BUDGET = 90;
export const SQL_BYTE_BUDGET = 32 * 1024;

export interface BuiltStatement {
  sql: string;
  params: SqlValue[];
  /** From `require: 'one'`: a lineage check the grant insert adds, so a missing target aborts the batch. */
  lineage?: Check;
  /** An included read part: it may bind up to PARAM_BUDGET values instead of WRITE_PARAM_BUDGET. */
  read?: true;
  /** A key limited to templates cannot run this: it assigns or omits a template reference it cannot check. */
  limitRefused?: true;
}

export function assertBudget(sql: string, params: readonly SqlValue[], limit: number): void {
  if (params.length > limit)
    throw new AuthorityError(
      'SQL_BIND_BUDGET',
      `Statement binds ${params.length} values (limit ${limit}).`,
    );
  if (sql.length > SQL_BYTE_BUDGET)
    throw new AuthorityError(
      'SQL_SIZE_BUDGET',
      `Statement is ${sql.length} bytes (limit ${SQL_BYTE_BUDGET}).`,
    );
}

export function tableScope(table: string): TableScope {
  const t = GUARDED_TABLES[identifier(table)];
  if (!t) throw new AuthorityError('GRANT_UNGUARDED_TABLE', `${table} is not a guarded table.`);
  return t;
}

export const override = (message: string) => new AuthorityError('GRANT_SCOPE_OVERRIDE', message);

/** Platform-only tables (users, sessions) are written by a platform grant, and only their listed columns. */
export function assertPlatformTable(t: TableScope, table: string, scope: GrantScope): void {
  if (t.platform && scope !== 'platform')
    throw override(`${table} is written only under a platform grant.`);
}

/**
 * The statement applies only when its own grant row exists and the target is inside the grant's tenant.
 * `when` conditions narrow it further at statement time; `row` is the written table for `{row}`.
 */
export function scopePredicate(
  grantId: string,
  scope: GrantScope,
  table: string,
  alias: string,
  params: SqlValue[],
  when?: readonly GrantCond[],
  row?: string,
  pin?: string,
  keyed = false,
): string {
  const t = tableScope(table);
  holderTable(t, table, pin);
  if (t.org === null) {
    if (!t.platform)
      throw new AuthorityError(
        'GRANT_NO_EDGE',
        `${table} has no org column: write it with joined() or insertJoined().`,
      );
    assertPlatformTable(t, table, scope);
    params.push(grantId);
    return `EXISTS (SELECT 1 FROM authority_grants g WHERE g.id = ?${whenSql(when, scope, params, row)})`;
  }
  params.push(grantId);
  const org =
    scope === 'platform'
      ? ''
      : t.org === 'scope'
        ? ` AND ${alias}.scope = 'org:' || g.org_id`
        : ` AND g.org_id = ${alias}.${t.org}`;
  const mode = scope === 'org_mode' && t.mode ? ` AND g.mode = ${alias}.mode` : '';
  const holder = pinPredicate(t, table, alias, pin);
  const limit = keyed ? restrictRow(table, alias, 'g.limit_key') : '';
  return `EXISTS (SELECT 1 FROM authority_grants g WHERE g.id = ?${org}${mode}${holder}${limit}${whenSql(when, scope, params, row)})`;
}

/** The grant supplies the tenant columns and triggers own the epochs: no write may name either. */
export function rejectOwned(
  table: string,
  scope: GrantScope,
  keys: string[],
  what: string,
  checkEpochs = true,
): void {
  const t = tableScope(table);
  const owned = ownedColumns(t, scope);
  const epochs = checkEpochs ? epochColumns(table) : new Set<string>();
  const edges = new Set((t.edges ?? []).map((e) => e.column));
  for (const key of keys) {
    identifier(key);
    if (owned.has(key)) throw override(`${what} cannot name ${key}: the grant supplies it.`);
    if (epochs.has(key)) throw override(`${what} cannot name ${key}: it is owned by triggers.`);
    if (edges.has(key)) throw override(`${what} cannot name ${key}: it is a parent key.`);
    if (t.platform && checkEpochs && !t.platform.columns.includes(key))
      throw override(
        `${what} cannot name ${key}: ${table} allows ${t.platform.columns.join(', ')}.`,
      );
  }
}

export function assignments(
  table: string,
  scope: GrantScope,
  set: Record<string, SetValue>,
  inc: string[],
  params: SqlValue[],
): string {
  rejectOwned(table, scope, [...Object.keys(set), ...inc], 'set');
  const parts = Object.entries(set).map(([column, value]) => renderSet(column, value, params));
  for (const column of inc) parts.push(`${column} = ${column} + 1`);
  if (parts.length === 0)
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'An update needs something to set.');
  return parts.join(', ');
}

export function conditions(
  where: Record<string, WhereValue>,
  params: SqlValue[],
  qualifier: string,
): string {
  return Object.entries(where)
    .map(([column, value]) => renderCond(qualifier, column, value, params))
    .join(' AND ');
}

export function returningSql(columns: string[] | undefined): string {
  return columns && columns.length > 0 ? ` RETURNING ${columns.map(identifier).join(', ')}` : '';
}

/** Prefixes an inert race-test marker comment (`scan/race-tags.ts`), so a race test finds the statement without matching its SQL. */
export const tagged = (built: BuiltStatement, tag: string | undefined): BuiltStatement =>
  tag ? { ...built, sql: `${tag} ${built.sql}` } : built;

export interface WriteOptions {
  /** Race-test marker comment (`scan/race-tags.ts`); no effect on the plan. */
  tag?: string;
  set?: Record<string, SetValue>;
  /** Columns raised by one, for example a client-visible version. */
  inc?: string[];
  where: Record<string, WhereValue>;
  /** Abort the batch (`authority_denied:lineage`) unless exactly one row in the tenant matches `where`. */
  require?: 'one';
  /** Columns of the changed rows, so callers count rows from `results` rather than `meta.changes`. */
  returning?: string[];
  /** Read-only conditions evaluated when the statement runs (it sees earlier statements of the batch). `{row}` is allowed. */
  when?: GrantCond[];
}

/** `where` may be empty only for the org row itself, which the grant pins. */
function whereSql(
  t: TableScope,
  table: string,
  scope: GrantScope,
  where: Record<string, WhereValue>,
  params: SqlValue[],
  pin?: string,
): string {
  pinWhere(t, table, where, pin);
  const keys = Object.keys(where);
  if (keys.length === 0 && !(t.org === 'id' && scope !== 'platform'))
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'A write needs a where clause.');
  rejectOwned(table, scope, keys, 'where', false);
  return keys.length === 0 ? '' : `${conditions(where, params, '')} AND `;
}

const lineageOf = (table: string, o: { require?: 'one'; where: Record<string, WhereValue> }) =>
  o.require === 'one' ? { lineage: exactlyOne(table, o.where) } : {};

export function buildUpdate(
  grantId: string,
  scope: GrantScope,
  table: string,
  o: WriteOptions,
  pin?: string,
  keyed = false,
): BuiltStatement {
  const t = tableScope(table);
  const params: SqlValue[] = [];
  const set = assignments(table, scope, o.set ?? {}, o.inc ?? [], params);
  const where = whereSql(t, table, scope, o.where, params, pin);
  // A limited key assigns a template column only a value inside its limit (see keyedSet).
  const limit = keyedSet(grantId, table, o, keyed);
  params.push(...limit.params);
  const guard = limit.sql ? `${limit.sql} AND ` : '';
  const sql = `UPDATE ${table} SET ${set} WHERE ${where}${guard}${scopePredicate(grantId, scope, table, table, params, o.when, table, pin, keyed)}${returningSql(o.returning)}`;
  return {
    sql,
    params,
    ...lineageOf(table, o),
    ...(limit?.refuse ? { limitRefused: true as const } : {}),
  };
}

export function buildDelete(
  grantId: string,
  scope: GrantScope,
  table: string,
  o: Omit<WriteOptions, 'set' | 'inc'>,
  pin?: string,
  keyed = false,
): BuiltStatement {
  const t = tableScope(table);
  if (t.platform) throw override(`${table} rows are not deleted through a grant.`);
  const params: SqlValue[] = [];
  const where = whereSql(t, table, scope, o.where, params, pin);
  const sql = `DELETE FROM ${table} WHERE ${where}${scopePredicate(grantId, scope, table, table, params, o.when, table, pin, keyed)}${returningSql(o.returning)}`;
  return { sql, params, ...lineageOf(table, o) };
}

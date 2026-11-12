import { type Check, exactlyOne, tenantMatch } from './authority-checks.ts';
import { type GrantCond, whenSql } from './authority-cond.ts';
import { AuthorityError } from './authority-error.ts';
import {
  identifier,
  renderCond,
  renderSet,
  type SetValue,
  type WhereValue,
} from './authority-expr.ts';
import { holderTable, pinInsert, pinPredicate, pinWhere } from './authority-pin.ts';
import type { GrantScope } from './authority-principal.ts';
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

const override = (message: string) => new AuthorityError('GRANT_SCOPE_OVERRIDE', message);

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
  return `EXISTS (SELECT 1 FROM authority_grants g WHERE g.id = ?${org}${mode}${holder}${whenSql(when, scope, params, row)})`;
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

export interface WriteOptions {
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
): BuiltStatement {
  const t = tableScope(table);
  const params: SqlValue[] = [];
  const set = assignments(table, scope, o.set ?? {}, o.inc ?? [], params);
  const where = whereSql(t, table, scope, o.where, params, pin);
  const sql = `UPDATE ${table} SET ${set} WHERE ${where}${scopePredicate(grantId, scope, table, table, params, o.when, table, pin)}${returningSql(o.returning)}`;
  return { sql, params, ...lineageOf(table, o) };
}

export function buildDelete(
  grantId: string,
  scope: GrantScope,
  table: string,
  o: Omit<WriteOptions, 'set' | 'inc'>,
  pin?: string,
): BuiltStatement {
  const t = tableScope(table);
  if (t.platform) throw override(`${table} rows are not deleted through a grant.`);
  const params: SqlValue[] = [];
  const where = whereSql(t, table, scope, o.where, params, pin);
  const sql = `DELETE FROM ${table} WHERE ${where}${scopePredicate(grantId, scope, table, table, params, o.when, table, pin)}${returningSql(o.returning)}`;
  return { sql, params, ...lineageOf(table, o) };
}

/** The leading tenant columns an insert takes from the grant row. */
function leadColumns(t: TableScope, scope: GrantScope): [string, string][] {
  if (scope === 'platform') return [];
  if (t.org === 'id') throw override('Only a platform grant creates an org.');
  const lead: [string, string][] = [
    t.org === 'scope' ? ['scope', `'org:' || g.org_id`] : ['org_id', 'g.org_id'],
  ];
  if (scope === 'org_mode' && t.mode) lead.push(['mode', 'g.mode']);
  return lead;
}

function checkInsertColumns(
  table: string,
  scope: GrantScope,
  columns: string[],
  values: SqlValue[],
  allowEmpty = false,
): TableScope {
  const t = tableScope(table);
  if (t.org === null)
    throw new AuthorityError(
      'GRANT_NO_EDGE',
      `${table} has no org column: write it with insertJoined().`,
    );
  if (columns.length !== values.length || (columns.length === 0 && !allowEmpty))
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'An insert needs matching columns and values.');
  rejectOwned(table, scope, columns, 'insert');
  return t;
}

/** Columns copied from one row of a guarded source table in the grant's tenant (target -> source column). */
export interface InsertFrom {
  table: string;
  where: Record<string, WhereValue>;
  copy: Record<string, string>;
}

export interface InsertOptions {
  returning?: string[];
  /** Read-only conditions evaluated when the statement runs. */
  when?: GrantCond[];
  /** Copy columns from a tenant source row; no matching row inserts nothing. */
  from?: InsertFrom;
}

/** The source join of `insertSelect({ from })`: the tenant comes from the grant row, never the request. */
function sourceJoin(
  table: string,
  scope: GrantScope,
  columns: string[],
  from: InsertFrom,
): { targets: string[]; sources: string[]; join: string } {
  const st = tableScope(from.table);
  if (st.org === null)
    throw new AuthorityError('GRANT_NO_EDGE', `${from.table} has no org column to copy from.`);
  const targets = Object.keys(from.copy);
  const sources = Object.values(from.copy).map(identifier);
  if (targets.length === 0 || Object.keys(from.where).length === 0)
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'from needs copy columns and a where clause.');
  rejectOwned(table, scope, targets, 'insert from');
  if (targets.some((c) => columns.includes(c)))
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'from.copy targets a column already inserted.');
  const owned = new Set([...ownedColumns(st, 'org_mode'), st.org]);
  for (const c of sources)
    if (owned.has(c)) throw override(`from.copy cannot read ${c}: the grant supplies it.`);
  rejectOwned(from.table, scope, Object.keys(from.where), 'from.where', false);
  return {
    targets,
    sources,
    join: ` JOIN ${from.table} s ON ${tenantMatch(from.table, 's', scope, 'g')}`,
  };
}

/** org_id (and mode) come from the grant row; the caller lists only the other columns. */
export function buildInsertSelect(
  grantId: string,
  scope: GrantScope,
  table: string,
  columns: string[],
  values: SqlValue[],
  o: InsertOptions = {},
  pin?: string,
): BuiltStatement {
  const t = checkInsertColumns(table, scope, columns, values, o.from !== undefined);
  const holder = pinInsert(t, table, columns, values, o.from?.copy, pin);
  const lead = leadColumns(t, scope);
  const src = o.from ? sourceJoin(table, scope, columns, o.from) : null;
  const all = [...lead.map(([c]) => c), ...columns, ...(src?.targets ?? [])];
  const select = [
    ...lead.map(([, e]) => e),
    ...columns.map(() => '?'),
    ...(src?.sources.map((c) => `s.${c}`) ?? []),
  ];
  const params: SqlValue[] = [...values, grantId, ...holder.params];
  const from = o.from && src ? ` AND ${conditions(o.from.where, params, 's.')}` : '';
  const when = whenSql(o.when, scope, params);
  return {
    sql: `INSERT INTO ${table} (${all.join(', ')}) SELECT ${select.join(', ')} FROM authority_grants g${src?.join ?? ''} WHERE g.id = ?${holder.sql}${from}${when}${returningSql(o.returning)}`,
    params,
  };
}

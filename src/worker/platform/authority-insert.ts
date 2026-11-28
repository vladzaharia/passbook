// `insertSelect`: org_id (and mode) come from the grant row; the caller lists only the other columns.
import { tenantMatch } from './authority-checks.ts';
import { type GrantCond, whenSql } from './authority-cond.ts';
import { AuthorityError } from './authority-error.ts';
import { identifier, type WhereValue } from './authority-expr.ts';
import { pinInsert } from './authority-pin.ts';
import type { GrantScope } from './authority-principal.ts';
import { keyedInsert, restrictRow } from './authority-restrict.ts';
import {
  type BuiltStatement,
  conditions,
  override,
  rejectOwned,
  returningSql,
  tableScope,
} from './authority-statements.ts';
import { ownedColumns, type TableScope } from './authority-tables.ts';
import type { SqlValue } from './db.ts';

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
  /** Race-test marker comment (`scan/race-tags.ts`); no effect on the plan. */
  tag?: string;
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
  keyed: boolean,
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
    join: ` JOIN ${from.table} s ON ${tenantMatch(from.table, 's', scope, 'g')}${keyed ? restrictRow(from.table, 's', 'g.limit_key') : ''}`,
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
  keyed = false,
): BuiltStatement {
  const t = checkInsertColumns(table, scope, columns, values, o.from !== undefined);
  const holder = pinInsert(t, table, columns, values, o.from?.copy, pin);
  const lead = leadColumns(t, scope);
  const src = o.from ? sourceJoin(table, scope, columns, o.from, keyed) : null;
  const all = [...lead.map(([c]) => c), ...columns, ...(src?.targets ?? [])];
  const select = [
    ...lead.map(([, e]) => e),
    ...columns.map(() => '?'),
    ...(src?.sources.map((c) => `s.${c}`) ?? []),
  ];
  const limit = keyedInsert(table, columns, values, o.from?.copy, keyed);
  const params: SqlValue[] = [...values, grantId, ...holder.params, ...limit.params];
  const from = o.from && src ? ` AND ${conditions(o.from.where, params, 's.')}` : '';
  const when = whenSql(o.when, scope, params);
  return {
    sql: `INSERT INTO ${table} (${all.join(', ')}) SELECT ${select.join(', ')} FROM authority_grants g${src?.join ?? ''} WHERE g.id = ?${holder.sql}${limit.sql}${from}${when}${returningSql(o.returning)}`,
    params,
    ...(limit.refuse ? { limitRefused: true as const } : {}),
  };
}

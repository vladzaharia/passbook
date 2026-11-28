// Writes to org-less child tables. Each is reached through a foreign key declared in
// GUARDED_TABLES (`edges`), and the parent row supplies the tenant. Never through a free-form join.
import { exactlyOne } from './authority-checks.ts';
import { type GrantCond, whenSql } from './authority-cond.ts';
import { AuthorityError } from './authority-error.ts';
import { identifier, type SetValue, type WhereValue } from './authority-expr.ts';
import type { InsertOptions } from './authority-insert.ts';
import { holderTable, pinWhere } from './authority-pin.ts';
import type { GrantScope } from './authority-principal.ts';
import { setRestriction } from './authority-restrict.ts';
import {
  assignments,
  type BuiltStatement,
  conditions,
  rejectOwned,
  returningSql,
  scopePredicate,
  tableScope,
} from './authority-statements.ts';
import type { Edge } from './authority-tables.ts';
import type { SqlValue } from './db.ts';

export interface JoinedOptions {
  /** Which declared edge reaches the parent, by the child column (default: the first edge). */
  via?: string;
  where: Record<string, WhereValue>;
  set?: Record<string, SetValue>;
  inc?: string[];
  /** Delete instead of update. */
  delete?: boolean;
  /** Abort the batch unless exactly one row matching `where` hangs off a parent in the tenant. */
  require?: 'one';
  returning?: string[];
  /** Read-only conditions evaluated when the statement runs; `{row}` is the child table. */
  when?: GrantCond[];
}

function edgesOf(table: string): Edge[] {
  const edges = tableScope(table).edges;
  if (!edges)
    throw new AuthorityError('GRANT_NO_EDGE', `${table} declares no foreign-key edge to a parent.`);
  return edges;
}

function pick(table: string, via: string | undefined): Edge {
  const edges = edgesOf(table);
  const found = via === undefined ? edges[0] : edges.find((e) => e.column === via);
  if (!found) throw new AuthorityError('GRANT_NO_EDGE', `${table} has no edge on ${via}.`);
  return found;
}

/** A child reached by a declared foreign key from a grant-scoped parent. Parent keys never change. */
export function buildJoined(
  grantId: string,
  scope: GrantScope,
  table: string,
  o: JoinedOptions,
  pin?: string,
  keyed = false,
): BuiltStatement {
  const edge = pick(table, o.via);
  holderTable(tableScope(table), table, pin);
  pinWhere(tableScope(table), table, o.where, pin);
  const params: SqlValue[] = [];
  for (const k of Object.keys(o.where)) {
    identifier(k);
    if (k === 'org_id' || k === 'mode')
      throw new AuthorityError(
        'GRANT_SCOPE_OVERRIDE',
        `joined where cannot name ${k}: the grant supplies it.`,
      );
  }
  const set = o.delete ? '' : assignments(table, scope, o.set ?? {}, o.inc ?? [], params);
  if (o.delete && (o.set || o.inc))
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'A joined delete takes no set.');
  const cond = Object.keys(o.where).length > 0 ? `${conditions(o.where, params, '')} AND ` : '';
  if (cond === '') throw new AuthorityError('GRANT_BAD_PURPOSE', 'A write needs a where clause.');
  const sub = scopePredicate(grantId, scope, edge.parent, 'p', params, o.when, table, pin, keyed);
  const exists = `EXISTS (SELECT 1 FROM ${edge.parent} p WHERE p.${edge.key} = ${table}.${edge.column} AND ${sub})`;
  const head = o.delete ? `DELETE FROM ${table}` : `UPDATE ${table} SET ${set}`;
  // A reference column of the child (one that is not an edge) cannot be re-pointed by a limited key.
  const refused = keyed && !o.delete && setRestriction(table, o).refuse;
  return {
    sql: `${head} WHERE ${cond}${exists}${returningSql(o.returning)}`,
    params,
    ...(o.require === 'one' ? { lineage: exactlyOne(table, o.where, edge.column) } : {}),
    ...(refused ? { limitRefused: true as const } : {}),
  };
}

export interface InsertJoinedOptions extends Omit<InsertOptions, 'from'> {
  /** One value per declared edge, keyed by the child column. The parent row must be in the tenant. */
  parents: Record<string, string>;
  columns: string[];
  /** One row of values. Give `rows` instead to insert several rows under the same parents. */
  values?: SqlValue[];
  /** Several rows, one statement: every row must have a value per column. */
  rows?: SqlValue[][];
}

/** `INSERT ... SELECT <parent keys>, ? FROM <parents> WHERE key = ? AND <parent in tenant>`. */
export function buildInsertJoined(
  grantId: string,
  scope: GrantScope,
  table: string,
  o: InsertJoinedOptions,
  pin?: string,
  keyed = false,
): BuiltStatement {
  const edges = edgesOf(table);
  holderTable(tableScope(table), table, pin);
  const named = Object.keys(o.parents);
  if (named.length !== edges.length || !edges.every((e) => named.includes(e.column)))
    throw new AuthorityError(
      'GRANT_NO_EDGE',
      `${table} needs a parent for each of ${edges.map((e) => e.column).join(', ')}.`,
    );
  if (pin !== undefined)
    for (const e of edges)
      if (tableScope(e.parent).pass && o.parents[e.column] !== pin)
        throw new AuthorityError(
          'GRANT_SCOPE_OVERRIDE',
          `${table}.${e.column} must be the holder's pass.`,
        );
  if ((o.values === undefined) === (o.rows === undefined))
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'An insert takes either values or rows.');
  const rows = o.rows ?? [o.values ?? []];
  if (rows.length === 0 || rows.some((row) => row.length !== o.columns.length))
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'An insert needs matching columns and values.');
  rejectOwned(table, scope, o.columns, 'insertJoined');
  const params: SqlValue[] = rows.flat();
  const where = edges.map((e, i) => {
    params.push(o.parents[e.column] ?? null);
    return `p${i}.${e.key} = ? AND ${scopePredicate(grantId, scope, e.parent, `p${i}`, params, undefined, undefined, pin, keyed)}`;
  });
  if ((o as InsertOptions).from)
    throw new AuthorityError(
      'GRANT_BAD_PURPOSE',
      'insertJoined takes its values from the parents.',
    );
  const all = [...edges.map((e) => e.column), ...o.columns];
  const bulk = o.rows !== undefined;
  const select = [
    ...edges.map((e, i) => `p${i}.${e.key}`),
    ...o.columns.map((_, i) => (bulk ? `v.column${i + 1}` : '?')),
  ];
  const values = `(VALUES ${rows.map(() => `(${o.columns.map(() => '?').join(', ')})`).join(', ')}) v`;
  const from = [...edges.map((e, i) => `${e.parent} p${i}`), ...(bulk ? [values] : [])].join(', ');
  let gate = '';
  if (o.when && o.when.length > 0) {
    params.push(grantId);
    gate = ` AND EXISTS (SELECT 1 FROM authority_grants g WHERE g.id = ?${whenSql(o.when, scope, params)})`;
  }
  return {
    sql: `INSERT INTO ${table} (${all.join(', ')}) SELECT ${select.join(', ')} FROM ${from} WHERE ${where.join(' AND ')}${gate}${returningSql(o.returning)}`,
    params,
  };
}

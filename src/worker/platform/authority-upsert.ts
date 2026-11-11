// Insert, or change the existing row at the table's fixed conflict target. Contract: builder-ext design 1.C.
import { AuthorityError } from './authority-error.ts';
import {
  identifier,
  renderCond,
  renderSet,
  type SetValue,
  type WhereValue,
} from './authority-expr.ts';
import type { GrantScope } from './authority-principal.ts';
import {
  type BuiltStatement,
  buildInsertSelect,
  type InsertOptions,
  rejectOwned,
  returningSql,
  tableScope,
} from './authority-statements.ts';
import { epochColumns, ownedColumns, type TableScope } from './authority-tables.ts';
import type { SqlValue } from './db.ts';

export interface UpsertOptions extends Omit<InsertOptions, 'from'> {
  /** col = excluded.col. Each must be an inserted column. */
  update?: string[];
  /** target = <table>.<source>: the existing row's value before this update. */
  copy?: Record<string, string>;
  /** Literals and vetted SetExprs over the existing row. */
  set?: Record<string, SetValue>;
  /** target = <table>.target + 1 */
  inc?: string[];
  /** Conditions on the existing row; a false WHERE makes the conflict a no-op (no RETURNING row). */
  where?: Record<string, WhereValue>;
  /** ON CONFLICT DO NOTHING. Exclusive with update, copy, set, inc and where. */
  doNothing?: true;
}

const bad = (message: string) => new AuthorityError('GRANT_BAD_PURPOSE', message);
const override = (message: string) => new AuthorityError('GRANT_SCOPE_OVERRIDE', message);

/** The guard that keeps `DO UPDATE` inside the grant's tenant: the conflicting row must carry the same org (and mode). */
function tenantGuard(t: TableScope, table: string, scope: GrantScope): string[] {
  if (scope === 'platform' || t.org === null) return [];
  const guard = [`${table}.${t.org} = excluded.${t.org}`];
  if (scope === 'org_mode' && t.mode) guard.push(`${table}.mode = excluded.mode`);
  return guard;
}

/** Targets of the DO UPDATE: never tenant, epoch, edge or conflict columns, and each named once. */
function checkTargets(
  t: TableScope,
  table: string,
  scope: GrantScope,
  target: string[],
  o: UpsertOptions,
): void {
  const lists = [o.update ?? [], Object.keys(o.copy ?? {}), Object.keys(o.set ?? {}), o.inc ?? []];
  const all = lists.flat();
  if (all.length === 0) throw bad('An upsert needs columns to update.');
  rejectOwned(table, scope, all, 'upsert update');
  const fixed = new Set([...target, ...ownedColumns(t, 'org_mode'), ...(t.org ? [t.org] : [])]);
  const seen = new Set<string>();
  for (const c of all) {
    if (fixed.has(c)) throw override(`upsert cannot update ${c}.`);
    if (seen.has(c)) throw bad(`upsert names ${c} more than once.`);
    seen.add(c);
  }
  const unreadable = new Set([
    ...ownedColumns(t, 'org_mode'),
    ...(t.org ? [t.org] : []),
    ...epochColumns(table),
  ]);
  for (const c of Object.values(o.copy ?? {}))
    if (unreadable.has(identifier(c))) throw override(`upsert copy cannot read ${c}.`);
}

/** Insert, or update the existing row at the table's fixed conflict target (settings, scans, scan gates). */
export function buildUpsert(
  grantId: string,
  scope: GrantScope,
  table: string,
  columns: string[],
  values: SqlValue[],
  o: UpsertOptions,
  pin?: string,
): BuiltStatement {
  if ((o as InsertOptions).from) throw bad('upsert takes its values from the caller.');
  const t = tableScope(table);
  const target = t.conflict;
  if (!target) throw bad(`${table} has no declared upsert target.`);
  const base = buildInsertSelect(
    grantId,
    scope,
    table,
    columns,
    values,
    { ...(o.when ? { when: o.when } : {}) },
    pin,
  );
  const lead =
    scope === 'platform' || !t.org
      ? []
      : [t.org, ...(scope === 'org_mode' && t.mode ? ['mode'] : [])];
  const named = new Set([...lead, ...columns]);
  for (const c of target) if (!named.has(c)) throw bad(`upsert must set ${c}.`);
  const key = `ON CONFLICT (${target.join(', ')})`;
  if (o.doNothing) {
    if (o.update || o.copy || o.set || o.inc || o.where)
      throw bad('doNothing takes no update, copy, set, inc or where.');
    return {
      sql: `${base.sql} ${key} DO NOTHING${returningSql(o.returning)}`,
      params: base.params,
    };
  }
  checkTargets(t, table, scope, target, o);
  for (const c of o.update ?? [])
    if (!columns.includes(c)) throw override(`upsert cannot update ${c}.`);
  const params = [...base.params];
  const parts = [
    ...(o.update ?? []).map((c) => `${c} = excluded.${c}`),
    ...Object.entries(o.copy ?? {}).map(([c, src]) => `${c} = ${table}.${identifier(src)}`),
    ...Object.entries(o.set ?? {}).map(([c, v]) => renderSet(c, v, params)),
    ...(o.inc ?? []).map((c) => `${c} = ${table}.${c} + 1`),
  ];
  const where = Object.keys(o.where ?? {});
  if (where.length > 0) rejectOwned(table, scope, where, 'upsert where', false);
  const guard = [
    ...tenantGuard(t, table, scope),
    ...Object.entries(o.where ?? {}).map(([c, v]) => renderCond(`${table}.`, c, v, params)),
  ];
  const tail = guard.length > 0 ? ` WHERE ${guard.join(' AND ')}` : '';
  return {
    sql: `${base.sql} ${key} DO UPDATE SET ${parts.join(', ')}${tail}${returningSql(o.returning)}`,
    params,
  };
}

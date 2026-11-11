// The small vetted expression set a guarded write may use. Fixed SQL text; every value is bound.
import { AuthorityError } from './authority-error.ts';
import type { SqlValue } from './db.ts';

const IDENT = /^[a-z_][a-z0-9_]*$/;
const JSON_PATH = /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const MAX_IN = 20;

export function identifier(name: string): string {
  if (!IDENT.test(name))
    throw new AuthorityError('GRANT_BAD_IDENTIFIER', `Invalid SQL identifier: ${name}`);
  return name;
}

/** A computed assignment: `column = <expr>`. */
export class SetExpr {
  readonly kind: 'max_now' | 'json_set' | 'coalesce';
  readonly value: SqlValue;
  readonly path: string | undefined;
  constructor(kind: SetExpr['kind'], value: SqlValue, path?: string) {
    this.kind = kind;
    this.value = value;
    this.path = path;
  }
}

/** A computed condition on a column. */
export class Cond {
  readonly kind: 'in' | 'gt' | 'lt' | 'gte' | 'lte' | 'ne' | 'or_null' | 'is_not_null';
  readonly value: SqlValue;
  readonly list: SqlValue[];
  /** The comparison an `or_null` wraps. */
  readonly inner: Cond | undefined;
  constructor(kind: Cond['kind'], value?: SqlValue, list: SqlValue[] = [], inner?: Cond) {
    this.kind = kind;
    this.value = value;
    this.list = list;
    this.inner = inner;
  }
}

export type SetValue = SqlValue | SetExpr;
export type WhereValue = SqlValue | Cond;

/** `column = MAX(column + 1, now)`: a timestamp that moves forward on every write. */
export const maxNow = (now: number): SetExpr => new SetExpr('max_now', now);
/** `column = json_set(column, path, value)`; the path is a fixed `$.a.b` literal checked here. */
export const jsonSet = (path: string, value: SqlValue): SetExpr => {
  if (!JSON_PATH.test(path))
    throw new AuthorityError('GRANT_BAD_IDENTIFIER', `Invalid JSON path: ${path}`);
  return new SetExpr('json_set', value, path);
};
/** `column = COALESCE(column, value)`: fill once. */
export const coalesceTo = (value: SqlValue): SetExpr => new SetExpr('coalesce', value);
export const inList = (values: SqlValue[]): Cond => {
  if (values.length === 0 || values.length > MAX_IN)
    throw new AuthorityError('GRANT_BAD_PURPOSE', `in() takes 1 to ${MAX_IN} values.`);
  return new Cond('in', undefined, values);
};
export const gt = (value: number): Cond => new Cond('gt', value);
export const lt = (value: number): Cond => new Cond('lt', value);
export const gte = (value: number): Cond => new Cond('gte', value);
export const lte = (value: number): Cond => new Cond('lte', value);
/** `column IS NOT ?`: NULL-safe, so a NULL column differs from every value. */
export const ne = (value: SqlValue): Cond => new Cond('ne', value);
export const isNotNull = (): Cond => new Cond('is_not_null');
const OR_NULL_INNER = new Set<Cond['kind']>(['gt', 'lt', 'gte', 'lte', 'ne']);
/** `(column IS NULL OR <inner>)`. Wraps gt, lt, gte, lte and ne only. */
export const orNull = (inner: Cond): Cond => {
  if (!OR_NULL_INNER.has(inner.kind))
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'orNull wraps gt, lt, gte, lte or ne.');
  return new Cond('or_null', undefined, [], inner);
};

/** The right-hand side of `column = ...` and its binds (in text order). */
export function renderSet(column: string, value: SetValue, params: SqlValue[]): string {
  if (!(value instanceof SetExpr)) {
    params.push(value);
    return `${column} = ?`;
  }
  switch (value.kind) {
    case 'max_now':
      params.push(value.value);
      return `${column} = MAX(${column} + 1, ?)`;
    case 'coalesce':
      params.push(value.value);
      return `${column} = COALESCE(${column}, ?)`;
    case 'json_set':
      params.push(value.path ?? null, value.value);
      return `${column} = json_set(${column}, ?, ?)`;
  }
}

/** One condition on `qualifier.column`; null means IS NULL. */
export function renderCond(
  qualifier: string,
  column: string,
  value: WhereValue,
  params: SqlValue[],
): string {
  const col = `${qualifier}${identifier(column)}`;
  if (value === undefined)
    throw new AuthorityError('GRANT_BAD_PURPOSE', `where.${column} is undefined.`);
  if (value === null) return `${col} IS NULL`;
  if (!(value instanceof Cond)) {
    params.push(value);
    return `${col} = ?`;
  }
  switch (value.kind) {
    case 'is_not_null':
      return `${col} IS NOT NULL`;
    case 'gt':
      params.push(value.value);
      return `${col} > ?`;
    case 'lt':
      params.push(value.value);
      return `${col} < ?`;
    case 'gte':
      params.push(value.value);
      return `${col} >= ?`;
    case 'lte':
      params.push(value.value);
      return `${col} <= ?`;
    case 'ne':
      params.push(value.value);
      return `${col} IS NOT ?`;
    case 'or_null':
      if (!value.inner) throw new AuthorityError('GRANT_BAD_PURPOSE', 'orNull wraps a condition.');
      return `(${col} IS NULL OR ${renderCond(qualifier, column, value.inner, params)})`;
    case 'in':
      params.push(...value.list);
      return `${col} IN (${value.list.map(() => '?').join(', ')})`;
  }
}

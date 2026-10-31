/** Thin typed helpers over D1. Raw SQL belongs in repo.ts files only. */
export type SqlValue = string | number | boolean | null | undefined | ArrayBuffer | Uint8Array;

function bindable(value: SqlValue): string | number | null | ArrayBuffer {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return value;
}

export function stmt(
  db: D1Database,
  sql: string,
  params: readonly SqlValue[] = [],
): D1PreparedStatement {
  return db.prepare(sql).bind(...params.map(bindable));
}

export async function first<T>(
  db: D1Database,
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<T | null> {
  return stmt(db, sql, params).first<T>();
}

export async function all<T>(
  db: D1Database,
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<T[]> {
  const result = await stmt(db, sql, params).all<T>();
  return result.results;
}

export async function run(
  db: D1Database,
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<{ changes: number }> {
  const result = await stmt(db, sql, params).run();
  return { changes: result.meta.changes ?? 0 };
}

/** Executes statements atomically (one D1 round trip, one transaction). */
export async function batch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  return db.batch(statements);
}

/** Splits a list for `IN (...)` clauses (D1 allows 100 bound parameters per query). */
export function chunk<T>(items: readonly T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Escapes `%`, `_` and the escape char for use in `LIKE ? ESCAPE '\'`. */
export function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface CasTarget {
  table: string;
  id: string;
  /** The version the caller read. The update only applies if the row still has it. */
  version: number;
}

/**
 * Optimistic update: `UPDATE ... SET <set>, version = version + 1 WHERE id = ? AND version = ?`.
 * Returns the new version, or null when the row changed (or is gone). Column names are
 * validated; values are always bound.
 */
export async function casUpdate(
  db: D1Database,
  target: CasTarget,
  set: Record<string, SqlValue>,
): Promise<number | null> {
  const columns = Object.keys(set);
  for (const name of [target.table, ...columns]) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  }
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  const sql = `UPDATE ${target.table} SET ${assignments}${assignments ? ', ' : ''}version = version + 1 WHERE id = ? AND version = ? RETURNING version`;
  const row = await first<{ version: number }>(db, sql, [
    ...columns.map((c) => set[c]),
    target.id,
    target.version,
  ]);
  return row?.version ?? null;
}

import { balanceSqlAnd } from './sql-balance.ts';

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
  return db.prepare(balanceSqlAnd(sql)).bind(...params.map(bindable));
}

/** Binds without rewriting the SQL. For statements built bounded, such as the authority grants. */
export function exactStmt(
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

/** D1 rejects a LIKE or GLOB pattern over 50 bytes. */
const LIKE_PATTERN_BYTES = 50;
const utf8 = new TextEncoder();
const fits = (pattern: string) => utf8.encode(pattern).length <= LIKE_PATTERN_BYTES;

export interface SqlMatch {
  sql: string;
  params: (string | number)[];
}

/** A SQL comment tag: kebab-case only, since it is spliced into the SQL text, not bound. */
function commentTag(comment: string): string {
  if (!comment) return '';
  if (!/^[a-z0-9-]+$/.test(comment)) throw new Error(`Invalid SQL comment tag: ${comment}`);
  return `/* ${comment} */`;
}

/**
 * `column LIKE 'q%'`, safe for any length of `q`. Case-folds ASCII like LIKE does. A pattern over
 * D1's cap keeps the LIKE on the longest head that fits (so the index still narrows) and compares
 * the full prefix exactly. `column` is trusted SQL; `comment` (kebab-case) is tagged into the SQL, not bound.
 */
export function prefixMatch(column: string, q: string, comment = ''): SqlMatch {
  const tag = commentTag(comment);
  const like = `${column} LIKE ?${tag} ESCAPE '\\'`;
  const full = `${likeEscape(q)}%`;
  if (fits(full)) return { sql: like, params: [full] };
  let head = '';
  for (const char of q) {
    const next = head + likeEscape(char);
    if (!fits(`${next}%`)) break;
    head = next;
  }
  return {
    sql: `(${like} AND substr(${column}, 1, ?) = ?${tag} COLLATE NOCASE)`,
    params: [`${head}%`, Array.from(q).length, q],
  };
}

/**
 * `column LIKE '%q%'`, safe for any length of `q`. A pattern over D1's cap becomes
 * `instr(lower(column), lower(q))`, which folds ASCII the same way.
 */
export function containsMatch(column: string, q: string, comment = ''): SqlMatch {
  const tag = commentTag(comment);
  const full = `%${likeEscape(q)}%`;
  if (fits(full)) return { sql: `${column} LIKE ?${tag} ESCAPE '\\'`, params: [full] };
  return { sql: `instr(lower(${column}), lower(?${tag})) > 0`, params: [q] };
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

export type D1ErrorKind = 'unique' | 'foreign_key' | 'abort';

export interface D1ErrorInfo {
  kind: D1ErrorKind;
  /** `table.column` list for unique violations, the RAISE text for aborts, else the message. */
  detail: string;
}

/** Maps D1's SQLite error text to a kind. Null for anything else, so callers rethrow. */
export function classifyD1Error(error: unknown): D1ErrorInfo | null {
  const message = error instanceof Error ? error.message : '';
  const unique = /UNIQUE constraint failed: ([^:]+?)(?::|$| \()/.exec(message);
  if (unique?.[1]) return { kind: 'unique', detail: unique[1] };
  if (/FOREIGN KEY constraint failed/i.test(message))
    return { kind: 'foreign_key', detail: message };
  const abort = /(?:^|: )(registration cap reached|authority_denied:[a-z]+)\b/.exec(message);
  if (abort?.[1]) return { kind: 'abort', detail: abort[1] };
  return null;
}

import { all, type SqlValue } from '../../src/worker/platform/db.ts';

/**
 * Runs a write and asserts it changed exactly `count` rows. It counts `RETURNING` rows, not
 * `meta.changes`: D1 adds the changes of trigger bodies (epoch bumps) to `meta.changes`, so that
 * number depends on which triggers fire. Pass a statement without a `RETURNING` clause.
 */
export async function runExactly(
  db: D1Database,
  sql: string,
  params: readonly SqlValue[],
  count: number,
): Promise<void> {
  const rows = await all<{ one: number }>(db, `${sql} RETURNING 1 AS one`, params);
  if (rows.length !== count)
    throw new Error(`Expected ${count} changed row(s), got ${rows.length}: ${sql}`);
}

/** Exactly one row changed. */
export const runOne = (db: D1Database, sql: string, params: readonly SqlValue[] = []) =>
  runExactly(db, sql, params, 1);

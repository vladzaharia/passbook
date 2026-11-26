import { expect } from 'vitest';
import { first } from '../../src/worker/platform/db.ts';

/**
 * The row holds the value a statement was meant to write. A statement's `changes` cannot say so for a table with
 * triggers: D1 counts the rows a trigger writes too (the Polaris ID dirty queue marks a linked account), so these
 * tests read the target row instead. `table`, `idColumn` and `column` are literals from the test.
 */
export async function expectValue(
  db: D1Database,
  table: string,
  idColumn: string,
  id: string,
  column: string,
  value: string | number,
): Promise<void> {
  const row = await first<Record<string, unknown>>(
    db,
    `SELECT ${column} AS v FROM ${table} WHERE ${idColumn} = ?`,
    [id],
  );
  expect(row?.v).toBe(value);
}

/** The row's column is set (a revoke or an end mark landed). */
export async function expectSet(
  db: D1Database,
  table: string,
  idColumn: string,
  id: string,
  column = 'revoked_at',
): Promise<void> {
  const row = await first<{ set: number }>(
    db,
    `SELECT ${column} IS NOT NULL AS "set" FROM ${table} WHERE ${idColumn} = ?`,
    [id],
  );
  expect(row?.set).toBe(1);
}

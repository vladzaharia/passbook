import { run, type SqlValue } from './db.ts';

export const DELETE_BATCH = 1000;
const MAX_BATCHES = 50;

/**
 * Deletes rows matching `where` in batches of 1000 (D1 guidance), up to 50 batches per call.
 * What is left is picked up by the next run.
 */
export async function deleteInBatches(
  db: D1Database,
  table: string,
  where: string,
  params: SqlValue[],
  maxBatches = MAX_BATCHES,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { changes } = await run(
      db,
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${DELETE_BATCH})`,
      params,
    );
    total += changes;
    if (changes < DELETE_BATCH) break;
  }
  return total;
}

import { deleteInBatches } from './batched.ts';
import { first, run } from './db.ts';

/** Fixed-window counters in D1 (the `counters` table). The only place that table is written. */

/** Adds `by` to the counter for the window and returns the new value. */
export async function bump(
  db: D1Database,
  key: string,
  windowStart: number,
  by = 1,
): Promise<number> {
  const row = await first<{ count: number }>(
    db,
    `INSERT INTO counters (key, window_start, count) VALUES (?, ?, ?)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + excluded.count RETURNING count`,
    [key, windowStart, by],
  );
  return row?.count ?? by;
}

export async function read(db: D1Database, key: string, windowStart: number): Promise<number> {
  const row = await first<{ count: number }>(
    db,
    'SELECT count FROM counters WHERE key = ? AND window_start = ?',
    [key, windowStart],
  );
  return row?.count ?? 0;
}

/** True for the first caller in the window; false when the window was already claimed. */
export async function claim(db: D1Database, key: string, windowStart: number): Promise<boolean> {
  const { changes } = await run(
    db,
    'INSERT OR IGNORE INTO counters (key, window_start, count) VALUES (?, ?, 1)',
    [key, windowStart],
  );
  return changes === 1;
}

/** Drops counters of the given kind older than the cutoff. `keyPattern` is a SQL LIKE pattern. */
export async function prune(db: D1Database, keyPattern: string, before: number): Promise<void> {
  await run(db, 'DELETE FROM counters WHERE key LIKE ? AND window_start < ?', [keyPattern, before]);
}

/** Retention: every counter window that started before the cutoff. */
export const pruneCounters = (db: D1Database, before: number) =>
  deleteInBatches(db, 'counters', 'window_start < ?', [before]);

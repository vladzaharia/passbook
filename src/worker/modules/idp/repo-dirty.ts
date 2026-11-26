import { all, first, run } from '../../platform/db.ts';

export interface DirtyRow {
  subject: string;
  version: number;
  attempts: number;
  next_at: number;
}

/** Retry delays after a failed drain of a subject: 1 minute, 5 minutes, 30 minutes, then 6 hours. */
export const BACKOFF_MS: readonly number[] = [60_000, 300_000, 1_800_000, 21_600_000];

/** Marks a subject for the next drain; the triggers do the same for D1 sources. A mark resets the backoff. */
export async function markDirty(db: D1Database, subject: string): Promise<void> {
  await run(
    db,
    `INSERT INTO idp_dirty (subject) VALUES (?)
     ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0`,
    [subject],
  );
}

/** Marks that are due, oldest due time first. The drain takes up to 20 a run. */
export const dueDirty = (db: D1Database, now: number, limit: number) =>
  all<DirtyRow>(
    db,
    'SELECT subject, version, attempts, next_at FROM idp_dirty WHERE next_at <= ? ORDER BY next_at, subject LIMIT ?',
    [now, limit],
  );

/** Clears the mark the drain read. A mark that arrived meanwhile has a newer version and stays. */
export async function clearDirty(
  db: D1Database,
  subject: string,
  version: number,
): Promise<boolean> {
  return (
    (await run(db, 'DELETE FROM idp_dirty WHERE subject = ? AND version = ?', [subject, version]))
      .changes > 0
  );
}

/**
 * A failed drain of the mark it read: the next due time moves out by the attempt count (capped at the last
 * delay). A mark that arrived meanwhile has a newer version and stays due now.
 */
export async function failDirty(
  db: D1Database,
  subject: string,
  version: number,
  now: number,
): Promise<boolean> {
  const [a, b, c, d] = BACKOFF_MS;
  return (
    (
      await run(
        db,
        `UPDATE idp_dirty SET next_at = ? + CASE attempts WHEN 0 THEN ${a} WHEN 1 THEN ${b} WHEN 2 THEN ${c} ELSE ${d} END,
           attempts = attempts + 1
         WHERE subject = ? AND version = ?`,
        [now, subject, version],
      )
    ).changes > 0
  );
}

/** One subject's mark, or null once a drain cleared it. */
export const dirtyOf = (db: D1Database, subject: string) =>
  first<DirtyRow>(
    db,
    'SELECT subject, version, attempts, next_at FROM idp_dirty WHERE subject = ?',
    [subject],
  );

export async function dirtyCount(db: D1Database): Promise<number> {
  const [row] = await all<{ n: number }>(db, 'SELECT count(*) AS n FROM idp_dirty');
  return row?.n ?? 0;
}

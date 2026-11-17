import { deleteInBatches } from '../../platform/batched.ts';
import { bump, prune } from '../../platform/counters.ts';
import { batch, stmt } from '../../platform/db.ts';

/** Adds `lines` to the hourly window and returns the new total. */
export const GLOBAL_LOG_KEY = 'apple.log';

export const bumpLogCounter = (db: D1Database, key: string, windowStart: number, lines: number) =>
  bump(db, key, windowStart, lines);

export async function insertLogs(
  db: D1Database,
  lines: string[],
  identityId: string | null,
  now: number,
): Promise<void> {
  await batch(
    db,
    lines.map((line) =>
      stmt(db, 'INSERT INTO wallet_logs (at, identity_id, line) VALUES (?, ?, ?)', [
        now,
        identityId,
        line,
      ]),
    ),
  );
}

export async function purgeLogs(db: D1Database, before: number): Promise<number> {
  const logs = await deleteInBatches(db, 'wallet_logs', 'at < ?', [before]);
  await prune(db, 'apple.log%', before);
  return logs;
}

export async function purgeRevisions(db: D1Database, before: number): Promise<number> {
  return deleteInBatches(db, 'revisions', 'at < ?', [before]);
}

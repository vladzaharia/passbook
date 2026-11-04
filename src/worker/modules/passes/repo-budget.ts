import { first } from '../../platform/db.ts';

/** Notifying `pass.updated` events after the first bound parameter (a time). */
export const notifiedWhere = `kind = 'pass.updated' AND at > ? AND json_extract(data, '$.notified') = 1`;

/** Notifying `pass.updated` events of one pass since `since`, and the oldest one's time. */
export async function notifiedSince(
  db: D1Database,
  passId: string,
  since: number,
): Promise<{ used: number; oldest: number | null }> {
  const row = await first<{ used: number; oldest: number | null }>(
    db,
    `SELECT COUNT(*) AS used, MIN(at) AS oldest FROM pass_events
     WHERE pass_id = ? AND ${notifiedWhere}`,
    [passId, since],
  );
  return { used: row?.used ?? 0, oldest: row?.oldest ?? null };
}

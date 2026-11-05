import type { BroadcastOutcome } from '../../../shared/contracts/broadcasts.ts';
import { all } from '../../platform/db.ts';

export interface ItemListRow {
  pass_id: string;
  title: string | null;
  holder_email: string | null;
  outcome: BroadcastOutcome;
  silent: number;
}

/** One page of a broadcast's per-pass outcomes, by pass id. */
export async function listItems(
  db: D1Database,
  broadcastId: string,
  f: { outcome?: BroadcastOutcome | undefined; cursor?: string | undefined; limit: number },
): Promise<{ rows: ItemListRow[]; nextCursor: string | null }> {
  const where = ['i.broadcast_id = ?'];
  const params: (string | number)[] = [broadcastId];
  if (f.outcome) {
    where.push('i.outcome = ?');
    params.push(f.outcome);
  }
  if (f.cursor) {
    where.push('i.pass_id > ?');
    params.push(f.cursor);
  }
  const rows = await all<ItemListRow>(
    db,
    `SELECT i.pass_id, p.display_title AS title, p.holder_email, i.outcome, i.silent
     FROM broadcast_items i JOIN passes p ON p.id = i.pass_id
     WHERE ${where.join(' AND ')} ORDER BY i.pass_id LIMIT ?`,
    [...params, f.limit + 1],
  );
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > f.limit && last ? last.pass_id : null };
}

/** True when a version written by `source` since `since` exists: a crashed run's own publish. */
export async function hasVersionFrom(
  db: D1Database,
  passId: string,
  source: string,
  since: number,
): Promise<boolean> {
  const rows = await all<{ one: number }>(
    db,
    'SELECT 1 AS one FROM pass_versions WHERE pass_id = ? AND source = ? AND created_at >= ? LIMIT 1',
    [passId, source, since],
  );
  return rows.length > 0;
}

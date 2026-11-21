import type { BroadcastOutcome } from '../../../shared/contracts/broadcasts.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';

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
  orgId: string,
  mode: Mode,
  f: { outcome?: BroadcastOutcome | undefined; cursor?: string | undefined; limit: number },
): Promise<{ rows: ItemListRow[]; nextCursor: string | null }> {
  const where = ['i.broadcast_id = ?', 'b.org_id = ?', 'b.mode = ?'];
  const params: (string | number)[] = [broadcastId, orgId, mode];
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
     FROM broadcast_items i
     JOIN broadcasts b ON b.id = i.broadcast_id
     JOIN passes p ON p.id = i.pass_id AND p.org_id = b.org_id AND p.mode = b.mode
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

/** The items of a change run that wrote something: what its undo will try to restore. */
export async function countRevertable(
  db: D1Database,
  parentId: string,
  orgId: string,
  mode: Mode,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM broadcast_items i JOIN broadcasts b ON b.id = i.broadcast_id
     WHERE i.broadcast_id = ? AND b.org_id = ? AND b.mode = ?
       AND i.before IS NOT NULL`,
    [parentId, orgId, mode],
  );
  return row?.n ?? 0;
}

/** Every item of a run with what it kept for the undo, by pass id (a test reads these). */
export const itemsWithBefore = (db: D1Database, broadcastId: string) =>
  all<{
    pass_id: string;
    outcome: string;
    before: string | null;
    version: number | null;
    silent: number;
  }>(
    db,
    'SELECT pass_id, outcome, before, version, silent FROM broadcast_items WHERE broadcast_id = ? ORDER BY pass_id',
    [broadcastId],
  );

export interface RevertItem {
  pass_id: string;
  before: string | null;
  version: number | null;
}

/** A change run's updated items after `cursor`, by pass id, for its undo. The run is read inside the undo's org and mode. */
export function revertItems(
  db: D1Database,
  parentId: string,
  orgId: string,
  mode: Mode,
  cursor: string | null,
  limit: number,
): Promise<RevertItem[]> {
  return all<RevertItem>(
    db,
    `SELECT i.pass_id, i.before, i.version FROM broadcast_items i JOIN broadcasts b ON b.id = i.broadcast_id
     WHERE i.broadcast_id = ? AND b.org_id = ? AND b.mode = ?
       AND i.before IS NOT NULL AND i.pass_id > ? ORDER BY i.pass_id LIMIT ?`,
    [parentId, orgId, mode, cursor ?? '', limit],
  );
}

/** Whether pass version `version` is a `schedule` write by this actor: a run's own write, not someone else's. */
export async function versionBy(
  db: D1Database,
  passId: string,
  version: number,
  actorType: string | null,
  actorId: string | null,
): Promise<boolean> {
  const row = await first<{ one: number }>(
    db,
    `SELECT 1 AS one FROM pass_versions WHERE pass_id = ? AND version = ? AND source = 'schedule'
       AND actor_type IS ? AND actor_id IS ?`,
    [passId, version, actorType, actorId],
  );
  return row !== null;
}

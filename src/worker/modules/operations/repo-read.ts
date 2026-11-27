import { assertActorOnce } from '../../platform/authority-read-once.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';
import { COLUMNS, type OperationRow } from './repo.ts';
import type { Fence } from './repo-fence.ts';

const O_COLUMNS = COLUMNS.split(',')
  .map((c) => `o.${c.trim()}`)
  .join(', ');

const prefix = (fence: Fence) => (fence.ctes ? `WITH ${fence.ctes}\n` : '');

/** A fenced read: the actor joins once, in the FROM (`assertActorOnce`). */
function fencedSql(fence: Fence, where: string, tail = ''): string {
  const sql = `${prefix(fence)}SELECT ${O_COLUMNS} FROM ${fence.from} WHERE ${where}${tail}`;
  if (fence.ctes) assertActorOnce(sql);
  return sql;
}

/** One row the fence lets the caller read; null for unknown and unreadable alike. */
export function getFenced(db: D1Database, fence: Fence, id: string): Promise<OperationRow | null> {
  return first<OperationRow>(db, fencedSql(fence, `o.id = ? AND ${fence.where}`), [
    ...fence.ctesParams,
    id,
    ...fence.whereParams,
  ]);
}

export interface ListFilter {
  active: boolean;
  /** Rows the caller started. */
  actor: { type: 'user' | 'api_key'; id: string } | null;
  kinds: readonly string[] | null;
  kind: string | null;
  target: { type: string; id: string } | null;
  /** The page after this `(created_at, id)`. */
  after: { createdAt: number; id: string } | null;
  limit: number;
}

/** A page, newest first. The WHERE holds only the filters that are present. */
export function listFenced(db: D1Database, fence: Fence, f: ListFilter): Promise<OperationRow[]> {
  const where = [fence.where];
  const params: SqlValue[] = [...fence.ctesParams, ...fence.whereParams];
  if (f.active) where.push(`o.status IN ('queued', 'running', 'waiting')`);
  if (f.actor) {
    where.push('o.actor_type = ? AND o.actor_id = ?');
    params.push(f.actor.type, f.actor.id);
  }
  if (f.kinds) {
    where.push(`o.kind IN (${f.kinds.map(() => '?').join(', ')})`);
    params.push(...f.kinds);
  }
  if (f.kind) {
    where.push('o.kind = ?');
    params.push(f.kind);
  }
  if (f.target) {
    where.push('o.target_type = ? AND o.target_id = ?');
    params.push(f.target.type, f.target.id);
  }
  if (f.after) {
    where.push('(o.created_at < ? OR (o.created_at = ? AND o.id < ?))');
    params.push(f.after.createdAt, f.after.createdAt, f.after.id);
  }
  params.push(f.limit);
  return all<OperationRow>(
    db,
    fencedSql(fence, where.join(' AND '), '\n     ORDER BY o.created_at DESC, o.id DESC LIMIT ?'),
    params,
  );
}

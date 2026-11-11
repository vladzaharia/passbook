import { all, likeEscape, type SqlValue } from '../../platform/db.ts';
import type { ConnectionRow, Health } from './repo.ts';
import { type ConnectionSql, toRow } from './repo-row.ts';

export async function listConnections(
  db: D1Database,
  q: {
    orgId?: string | undefined;
    health?: Health | undefined;
    q?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<ConnectionRow[]> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const term = q.q?.trim().toLowerCase();
  if (term) {
    where.push("lower(name) LIKE ? ESCAPE '\\'");
    params.push(`%${likeEscape(term)}%`);
  }
  if (q.orgId !== undefined) {
    where.push('org_id = ?');
    params.push(q.orgId);
  }
  if (q.health) {
    where.push('health = ?');
    params.push(q.health);
  }
  if (q.cursor) {
    where.push('id < ?');
    params.push(q.cursor);
  }
  const rows = await all<ConnectionSql>(
    db,
    `SELECT * FROM connections ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
    [...params, q.limit],
  );
  return rows.map(toRow);
}

export async function listDueConnections(db: D1Database, now: number, limit: number) {
  const rows = await all<ConnectionSql>(
    db,
    `SELECT c.* FROM connections c JOIN orgs o ON o.id = c.org_id
     WHERE c.enabled = 1 AND o.status = 'active'
       AND c.next_run_at IS NOT NULL AND c.next_run_at <= ?
       AND (c.breaker_open_until IS NULL OR c.breaker_open_until <= ?)
     ORDER BY c.next_run_at LIMIT ?`,
    [now, now, limit],
  );
  return rows.map(toRow);
}

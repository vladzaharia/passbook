import { all, containsMatch, type SqlValue } from '../../platform/db.ts';
import type { ConnectionRow, Health } from './repo.ts';
import { type ConnectionSql, toRow } from './repo-row.ts';

export async function listConnections(
  db: D1Database,
  q: {
    orgId?: string | undefined;
    health?: Health | 'awaiting' | undefined;
    q?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<ConnectionRow[]> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const term = q.q?.trim().toLowerCase();
  if (term) {
    const match = containsMatch('lower(name)', term);
    where.push(match.sql);
    params.push(...match.params);
  }
  if (q.orgId !== undefined) {
    where.push('org_id = ?');
    params.push(q.orgId);
  }
  if (q.health) {
    // `awaiting` is not stored: it is an unknown webhook connection with no verified delivery yet.
    const awaiting = `mode IN ('webhook', 'hybrid') AND NOT EXISTS (
      SELECT 1 FROM connection_webhook_arrivals a WHERE a.connection_id = connections.id AND a.outcome <> 'rejected')`;
    if (q.health === 'awaiting') where.push(`health = 'unknown' AND ${awaiting}`);
    else if (q.health === 'unknown') where.push(`health = 'unknown' AND NOT (${awaiting})`);
    else {
      where.push('health = ?');
      params.push(q.health);
    }
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

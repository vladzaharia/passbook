import { all, likeEscape, run, type SqlValue } from '../../platform/db.ts';

export interface AuditRow {
  id: number;
  at: number;
  org_id: string | null;
  actor_type: 'user' | 'api_key' | 'system' | 'connection' | 'device';
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  detail: string | null;
}

export interface AuditFilter {
  orgId?: string;
  actorId?: string;
  /** Prefix match. */
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: number;
  to?: number;
  /** Exclusive upper bound on id (newest first paging). */
  before?: number;
}

export async function listAuditRows(
  db: D1Database,
  filter: AuditFilter,
  limit: number,
): Promise<AuditRow[]> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const add = (clause: string, value: SqlValue) => {
    where.push(clause);
    params.push(value);
  };
  if (filter.orgId) add('org_id = ?', filter.orgId);
  if (filter.actorId) add('actor_id = ?', filter.actorId);
  if (filter.action) add("action LIKE ? ESCAPE '\\'", `${likeEscape(filter.action)}%`);
  if (filter.targetType) add('target_type = ?', filter.targetType);
  if (filter.targetId) add('target_id = ?', filter.targetId);
  if (filter.from !== undefined) add('at >= ?', filter.from);
  if (filter.to !== undefined) add('at <= ?', filter.to);
  if (filter.before !== undefined) add('id < ?', filter.before);
  const sql = `SELECT id, at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, detail
     FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return all<AuditRow>(db, sql, [...params, limit]);
}

/** Deletes up to `limit` rows older than the cutoff; returns how many went. */
export async function deleteAuditBefore(
  db: D1Database,
  cutoff: number,
  limit: number,
): Promise<number> {
  const { changes } = await run(
    db,
    'DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ? ORDER BY at LIMIT ?)',
    [cutoff, limit],
  );
  return changes;
}

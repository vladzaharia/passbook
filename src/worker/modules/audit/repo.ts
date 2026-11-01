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
  /** Prefix to leave out. */
  excludeAction?: string;
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
  if (filter.excludeAction)
    add("action NOT LIKE ? ESCAPE '\\'", `${likeEscape(filter.excludeAction)}%`);
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

/** Where a referenced entity's display name lives. */
const LABEL_SOURCES: Record<string, { table: string; expr: string }> = {
  user: { table: 'users', expr: 'COALESCE(name, primary_email)' },
  pass: { table: 'passes', expr: 'display_title' },
  org: { table: 'orgs', expr: 'name' },
  template: { table: 'templates', expr: 'name' },
  connection: { table: 'connections', expr: 'name' },
  api_key: { table: 'api_keys', expr: 'name' },
  identity: { table: 'signing_identities', expr: 'label' },
};

export const labelKey = (type: string, id: string) => `${type}:${id}`;

/** One query per entity type; entities that no longer exist simply have no label. */
export async function loadLabels(
  db: D1Database,
  refs: { type: string; id: string }[],
): Promise<Map<string, string>> {
  const byType = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!LABEL_SOURCES[ref.type]) continue;
    byType.set(ref.type, (byType.get(ref.type) ?? new Set()).add(ref.id));
  }
  const labels = new Map<string, string>();
  for (const [type, ids] of byType) {
    const source = LABEL_SOURCES[type];
    if (!source) continue;
    const list = [...ids];
    const rows = await all<{ id: string; label: string | null }>(
      db,
      `SELECT id, ${source.expr} AS label FROM ${source.table} WHERE id IN (${list.map(() => '?').join(',')})`,
      list,
    );
    for (const row of rows) if (row.label) labels.set(labelKey(type, row.id), row.label);
  }
  return labels;
}

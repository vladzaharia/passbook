import type { Mode } from '../../../shared/contracts/common.ts';
import { all, likeEscape } from '../../platform/db.ts';
import { TEMPLATE_COLUMNS, type TemplateRow, type TemplateSql, templateRow } from './repo.ts';

export interface ListFilter {
  /** String: that org plus platform templates. Null: platform only. Undefined: everything. */
  orgId?: string | null;
  origin?: 'baked' | 'uploaded';
  status?: TemplateRow['status'];
  includeArchived?: boolean;
  /** Substring of the name or slug. */
  q?: string;
  limit: number;
  cursor?: { createdAt: number; id: string } | null;
  /** Which mode's passes the pass counts cover. Default live. */
  mode?: Mode;
}

export interface ListedTemplate extends TemplateRow {
  passCount: number;
  orgName: string | null;
}

export async function listTemplates(db: D1Database, f: ListFilter): Promise<ListedTemplate[]> {
  const where: string[] = [];
  const params: (string | number | null)[] = [];
  if (f.status) {
    where.push('t.status = ?');
    params.push(f.status);
  } else where.push(f.includeArchived ? "t.status != 'deleted'" : "t.status = 'active'");
  if (f.orgId === null) where.push('t.org_id IS NULL');
  else if (f.orgId !== undefined) {
    where.push('(t.org_id = ? OR t.org_id IS NULL)');
    params.push(f.orgId);
  }
  if (f.origin) {
    where.push('t.origin = ?');
    params.push(f.origin);
  }
  if (f.q) {
    const like = `%${likeEscape(f.q.toLowerCase())}%`;
    where.push("(lower(t.name) LIKE ? ESCAPE '\\' OR t.slug LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  if (f.cursor) {
    where.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))');
    params.push(f.cursor.createdAt, f.cursor.createdAt, f.cursor.id);
  }
  const rows = await all<TemplateSql & { pass_count: number; org_name: string | null }>(
    db,
    `SELECT ${TEMPLATE_COLUMNS.split(', ')
      .map((c) => `t.${c}`)
      .join(', ')},
       (SELECT COUNT(*) FROM passes p WHERE p.template_id = t.id AND p.deleted_at IS NULL AND p.mode = ?) AS pass_count,
       (SELECT o.name FROM orgs o WHERE o.id = t.org_id) AS org_name
     FROM templates t WHERE ${where.join(' AND ')}
     ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
    [f.mode ?? 'live', ...params, f.limit],
  );
  return rows.map((r) => ({ ...templateRow(r), passCount: r.pass_count, orgName: r.org_name }));
}

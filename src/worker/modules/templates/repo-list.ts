import type { Mode } from '../../../shared/contracts/common.ts';
import { all, containsMatch, first } from '../../platform/db.ts';
import { TEMPLATE_COLUMNS, type TemplateRow, type TemplateSql, templateRow } from './repo.ts';

export interface ListFilter {
  /** String: that org plus platform templates. Null: platform only. Undefined: everything. */
  orgId?: string | null;
  origin?: 'baked' | 'uploaded';
  /** True: blueprints only. False: templates only. Undefined: both. */
  blueprint?: boolean;
  status?: TemplateRow['status'];
  includeArchived?: boolean;
  /** Substring of the name or slug. */
  q?: string;
  limit: number;
  cursor?: { createdAt: number; id: string } | null;
  /** Which mode's passes the pass counts cover. Default live. */
  mode?: Mode;
  /** Pass-count scope: string for one org, null for none, undefined for all. */
  passOrgId?: string | null;
}

/**
 * A platform template a tenant may see: a baked one, a shared upload, or an upload the org already holds
 * a candidate or release of, or holds a pass on (unsharing never takes those away). Other platform uploads are staged.
 */
const GLOBAL_VISIBLE = `(t.org_id IS NULL AND (t.origin = 'baked' OR t.shared = 1
  OR EXISTS (SELECT 1 FROM template_releases r WHERE r.template_id = t.id AND r.org_id = ?)
  OR EXISTS (SELECT 1 FROM template_candidates c WHERE c.template_id = t.id AND c.org_id = ?)
  OR EXISTS (SELECT 1 FROM passes vp WHERE vp.template_id = t.id AND vp.org_id = ? AND vp.deleted_at IS NULL)))`;

export async function globalTemplateVisible(
  db: D1Database,
  templateId: string,
  orgId: string,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM templates t WHERE t.id = ? AND ${GLOBAL_VISIBLE}`,
    [templateId, orgId, orgId, orgId],
  );
  return row !== null;
}

export interface ListedTemplate extends TemplateRow {
  passCount: number;
  orgName: string | null;
  /** `display.icon` of the version shown. */
  icon: string | null;
  fromBlueprint: { id: string; name: string } | null;
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
    where.push(`(t.org_id = ? OR ${GLOBAL_VISIBLE})`);
    params.push(f.orgId, f.orgId, f.orgId, f.orgId);
  }
  if (f.blueprint !== undefined) {
    where.push('t.blueprint = ?');
    params.push(f.blueprint ? 1 : 0);
  }
  if (f.origin) {
    where.push('t.origin = ?');
    params.push(f.origin);
  }
  if (f.q) {
    const term = f.q.toLowerCase();
    const name = containsMatch('lower(t.name)', term);
    const slug = containsMatch('t.slug', term);
    where.push(`(${name.sql} OR ${slug.sql})`);
    params.push(...name.params, ...slug.params);
  }
  if (f.cursor) {
    where.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))');
    params.push(f.cursor.createdAt, f.cursor.createdAt, f.cursor.id);
  }
  const rows = await all<
    TemplateSql & {
      pass_count: number;
      org_name: string | null;
      icon: unknown;
      from_name: string | null;
    }
  >(
    db,
    `SELECT ${TEMPLATE_COLUMNS.split(', ')
      .map((c) => `t.${c}`)
      .join(', ')},
       (SELECT COUNT(*) FROM passes p WHERE p.template_id = t.id AND p.deleted_at IS NULL AND p.mode = ?${f.passOrgId === undefined ? '' : ' AND p.org_id = ?'}) AS pass_count,
       (SELECT o.name FROM orgs o WHERE o.id = t.org_id) AS org_name,
       (SELECT json_extract(v.manifest, '$.display.icon') FROM template_versions v
         WHERE v.template_id = t.id AND v.version = t.active_version) AS icon,
       (SELECT b.name FROM templates b WHERE b.id = t.source_blueprint) AS from_name
     FROM templates t WHERE ${where.join(' AND ')}
     ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
    [f.mode ?? 'live', ...(f.passOrgId === undefined ? [] : [f.passOrgId]), ...params, f.limit],
  );
  return rows.map((r) => ({
    ...templateRow(r),
    passCount: r.pass_count,
    orgName: r.org_name,
    icon: typeof r.icon === 'string' ? r.icon : null,
    fromBlueprint:
      r.source_blueprint && r.from_name ? { id: r.source_blueprint, name: r.from_name } : null,
  }));
}

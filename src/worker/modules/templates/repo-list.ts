import type { Mode } from '../../../shared/contracts/common.ts';
import { all, containsMatch, first } from '../../platform/db.ts';
import { TEMPLATE_COLUMNS, type TemplateRow, type TemplateSql, templateRow } from './repo.ts';
import { OPEN_REVIEW_SQL } from './repo-reviews.ts';
import { templateVisibleSql, visibleBinds } from './repo-visibility.ts';

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

/** The template is one the org may see (its own, or a platform one offered to it). */
export async function templateVisibleToOrg(
  db: D1Database,
  templateId: string,
  orgId: string,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM templates t WHERE t.id = ? AND ${templateVisibleSql('t', '?')}`,
    [templateId, ...visibleBinds(orgId)],
  );
  return row !== null;
}

/** json_extract hands an array back as JSON text. */
function aliasList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export interface ListedTemplate extends TemplateRow {
  passCount: number;
  orgName: string | null;
  /** `display.icon` of the version shown. */
  icon: string | null;
  /** `display.group` and `display.aliases` of the version shown. */
  group: string | null;
  aliases: string[];
  fromBlueprint: { id: string; name: string } | null;
  /** A Live review request for the newest version is waiting for a peer. */
  openReview: boolean;
}

export async function listTemplates(db: D1Database, f: ListFilter): Promise<ListedTemplate[]> {
  const where: string[] = [];
  const params: (string | number | null)[] = [];
  if (f.status) {
    where.push('t.status = ?');
    params.push(f.status);
  } else where.push(f.includeArchived ? "t.status != 'deleted'" : "t.status = 'active'");
  // A platform-wide read (no org named) never reaches into a personal org.
  if (f.orgId === undefined)
    where.push(
      '(t.org_id IS NULL OR NOT EXISTS (SELECT 1 FROM orgs po WHERE po.id = t.org_id AND po.personal_user_id IS NOT NULL))',
    );
  if (f.orgId === null) where.push('t.org_id IS NULL');
  else if (f.orgId !== undefined) {
    where.push(templateVisibleSql('t', '?'));
    params.push(...visibleBinds(f.orgId));
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
      grp: unknown;
      aliases: unknown;
      from_name: string | null;
      open_review: number;
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
       (SELECT json_extract(v.manifest, '$.display.group') FROM template_versions v
         WHERE v.template_id = t.id AND v.version = t.active_version) AS grp,
       (SELECT json_extract(v.manifest, '$.display.aliases') FROM template_versions v
         WHERE v.template_id = t.id AND v.version = t.active_version) AS aliases,
       (SELECT b.name FROM templates b WHERE b.id = t.source_blueprint) AS from_name,
       ${OPEN_REVIEW_SQL} AS open_review
     FROM templates t WHERE ${where.join(' AND ')}
     ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
    [f.mode ?? 'live', ...(f.passOrgId === undefined ? [] : [f.passOrgId]), ...params, f.limit],
  );
  return rows.map((r) => ({
    ...templateRow(r),
    passCount: r.pass_count,
    orgName: r.org_name,
    icon: typeof r.icon === 'string' ? r.icon : null,
    group: typeof r.grp === 'string' ? r.grp : null,
    aliases: aliasList(r.aliases),
    fromBlueprint:
      r.source_blueprint && r.from_name ? { id: r.source_blueprint, name: r.from_name } : null,
    openReview: r.open_review === 1,
  }));
}

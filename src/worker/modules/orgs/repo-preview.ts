import { first } from '../../platform/db.ts';

/**
 * The template the org's passes use most (live passes; a platform template counts when they use
 * it), else the org's first own template. Null when the org has neither.
 */
export async function previewTemplateId(db: D1Database, orgId: string): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    `SELECT t.id FROM templates t
     LEFT JOIN (
       SELECT template_id, COUNT(*) AS n FROM passes
       WHERE org_id = ? AND deleted_at IS NULL GROUP BY template_id
     ) used ON used.template_id = t.id
     WHERE t.status = 'active' AND t.active_version IS NOT NULL AND (t.org_id = ? OR (t.org_id IS NULL AND used.n > 0))
     ORDER BY COALESCE(used.n, 0) DESC, t.created_at, t.id
     LIMIT 1`,
    [orgId, orgId],
  );
  return row?.id ?? null;
}

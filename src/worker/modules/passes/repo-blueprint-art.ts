import { all } from '../../platform/db.ts';

/** The stored asset lists of every version of the blueprint a template was made from. */
export async function sourceBlueprintAssets(db: D1Database, templateId: string): Promise<string[]> {
  const rows = await all<{ assets: string }>(
    db,
    `SELECT v.assets FROM templates t
     JOIN template_versions v ON v.template_id = t.source_blueprint
     WHERE t.id = ?`,
    [templateId],
  );
  return rows.map((r) => r.assets);
}

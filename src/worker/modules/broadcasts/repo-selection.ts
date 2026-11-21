import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';

/** The templates of the chosen passes of this org and mode, and how many of the ids exist there (500 ids a query). */
export async function chosenPassTemplates(
  db: D1Database,
  orgId: string,
  mode: Mode,
  ids: readonly string[],
): Promise<{ templates: string[]; found: number }> {
  const templates = new Set<string>();
  let found = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await all<{ template_id: string }>(
      db,
      `SELECT template_id FROM passes WHERE org_id = ? AND mode = ? AND deleted_at IS NULL
         AND id IN (SELECT value FROM json_each(?))`,
      [orgId, mode, JSON.stringify(ids.slice(i, i + 500))],
    );
    found += rows.length;
    for (const r of rows) templates.add(r.template_id);
  }
  return { templates: [...templates], found };
}

/** An import's template, inside the org and mode. */
export const importTemplate = (db: D1Database, importId: string, orgId: string, mode: Mode) =>
  first<{ template_id: string }>(
    db,
    'SELECT template_id FROM pass_imports WHERE id = ? AND org_id = ? AND mode = ?',
    [importId, orgId, mode],
  );

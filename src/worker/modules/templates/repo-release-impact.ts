import { first } from '../../platform/db.ts';

/** Passes of the org on the template, in the mode, not yet on `version`, counted up to `limit`. */
export async function countPassesNotOnVersion(
  db: D1Database,
  input: { templateId: string; orgId: string; mode: string; version: string; limit: number },
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM passes
       WHERE template_id = ? AND org_id = ? AND mode = ? AND deleted_at IS NULL AND template_version != ?
       LIMIT ?)`,
    [input.templateId, input.orgId, input.mode, input.version, input.limit],
  );
  return row?.n ?? 0;
}

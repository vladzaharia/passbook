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

/** Pass-device registrations of those passes, counted up to `limit`. */
export async function countDevicesNotOnVersion(
  db: D1Database,
  input: { templateId: string; orgId: string; mode: string; version: string; limit: number },
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM registrations r JOIN passes p ON p.id = r.pass_id
       WHERE p.template_id = ? AND p.org_id = ? AND p.mode = ? AND p.deleted_at IS NULL
         AND p.template_version != ?
       LIMIT ?)`,
    [input.templateId, input.orgId, input.mode, input.version, input.limit],
  );
  return row?.n ?? 0;
}

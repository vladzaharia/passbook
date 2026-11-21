import { all, first } from '../../platform/db.ts';

interface ImpactInput {
  templateId: string;
  orgId: string;
  mode: string;
  version: string;
  limit: number;
}

/**
 * The rule the stale-reissue cron applies: an active pass on another version whose build differs
 * from `version`'s (or is unknown). `p` is the pass, `pinned` its version, `target` the new one.
 */
export const MOVES_WITH_RELEASE = `p.template_id = ? AND p.org_id = ? AND p.mode = ?
  AND p.status = 'active' AND p.deleted_at IS NULL AND p.template_version != ?
  AND (pinned.build_key IS NULL OR target.build_key IS NULL OR pinned.build_key != target.build_key)`;

const versionJoins = `
  LEFT JOIN template_versions pinned ON pinned.template_id = p.template_id AND pinned.version = p.template_version
  LEFT JOIN template_versions target ON target.template_id = p.template_id AND target.version = ?`;

const args = (i: ImpactInput) => [i.version, i.templateId, i.orgId, i.mode, i.version, i.limit];

/** Passes the release would move (what the cron moves), counted up to `limit`. */
export async function countPassesNotOnVersion(db: D1Database, input: ImpactInput): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM passes p ${versionJoins}
       WHERE ${MOVES_WITH_RELEASE}
       LIMIT ?)`,
    args(input),
  );
  return row?.n ?? 0;
}

/** Pass-device registrations of those passes, counted up to `limit`. */
export async function countDevicesNotOnVersion(
  db: D1Database,
  input: ImpactInput,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM registrations r JOIN passes p ON p.id = r.pass_id ${versionJoins}
       WHERE ${MOVES_WITH_RELEASE}
       LIMIT ?)`,
    args(input),
  );
  return row?.n ?? 0;
}

/** Active passes of the org on the template, in the mode. */
export async function countActivePasses(
  db: D1Database,
  input: { templateId: string; orgId: string; mode: string },
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM passes
     WHERE template_id = ? AND org_id = ? AND mode = ? AND status = 'active' AND deleted_at IS NULL`,
    [input.templateId, input.orgId, input.mode],
  );
  return row?.n ?? 0;
}

/** The first passes the cron would move, oldest first. */
export async function listPassesNotOnVersion(
  db: D1Database,
  input: ImpactInput,
): Promise<{ id: string; title: string | null }[]> {
  return all<{ id: string; title: string | null }>(
    db,
    `SELECT p.id, p.display_title AS title FROM passes p ${versionJoins}
     WHERE ${MOVES_WITH_RELEASE}
     ORDER BY p.created_at, p.id LIMIT ?`,
    args(input),
  );
}

/** Rebuilds of the template for the org since `since`, across modes. */
export async function rebuildsSince(
  db: D1Database,
  input: { templateId: string; orgId: string; since: number },
): Promise<{ n: number; open: number; latestId: string | null }> {
  const row = await first<{ n: number; open: number | null; latest: string | null }>(
    db,
    `SELECT COUNT(*) AS n,
       SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS open,
       (SELECT instance_id FROM workflow_runs
        WHERE kind = 'bulk_reissue' AND target_id = ?1 AND org_id = ?2 AND started_at >= ?3
        ORDER BY started_at DESC, instance_id DESC LIMIT 1) AS latest
     FROM workflow_runs
     WHERE kind = 'bulk_reissue' AND target_id = ?1 AND org_id = ?2 AND started_at >= ?3`,
    [input.templateId, input.orgId, input.since],
  );
  return { n: row?.n ?? 0, open: row?.open ?? 0, latestId: row?.latest ?? null };
}

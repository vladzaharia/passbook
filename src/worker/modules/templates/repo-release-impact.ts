import { all, first, run } from '../../platform/db.ts';

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

/**
 * Passes the cron would move that stayed behind: those with a recorded failure for `releaseId`
 * and, when every rebuild has finished (`settled`), the others too. Recorded ones come first.
 */
export async function listLeftBehind(
  db: D1Database,
  input: ImpactInput & { releaseId: string; settled: boolean },
): Promise<{ id: string; title: string | null; message: string | null }[]> {
  return all<{ id: string; title: string | null; message: string | null }>(
    db,
    `SELECT p.id, p.display_title AS title, f.message FROM passes p ${versionJoins}
     LEFT JOIN template_rollout_failures f ON f.pass_id = p.id AND f.release_id = ?
     WHERE ${MOVES_WITH_RELEASE} AND (? = 1 OR f.pass_id IS NOT NULL)
     ORDER BY f.pass_id IS NULL, p.created_at, p.id LIMIT ?`,
    [
      input.version,
      input.releaseId,
      input.templateId,
      input.orgId,
      input.mode,
      input.version,
      input.settled ? 1 : 0,
      input.limit,
    ],
  );
}

/** How many of those passes have a recorded failure for `releaseId`. */
export async function countRecordedFailures(
  db: D1Database,
  input: ImpactInput & { releaseId: string },
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM passes p ${versionJoins}
       JOIN template_rollout_failures f ON f.pass_id = p.id AND f.release_id = ?
       WHERE ${MOVES_WITH_RELEASE}
       LIMIT ?)`,
    [
      input.version,
      input.releaseId,
      input.templateId,
      input.orgId,
      input.mode,
      input.version,
      input.limit,
    ],
  );
  return row?.n ?? 0;
}

/** The reissue workflow's note of why it could not move a pass; tenant-checked against the pass row. */
export async function recordRolloutFailure(
  db: D1Database,
  input: {
    passId: string;
    orgId: string;
    mode: string;
    templateId: string;
    releaseId: string;
    code: string;
    message: string;
    at: number;
  },
): Promise<void> {
  await run(
    db,
    `INSERT INTO template_rollout_failures (pass_id, release_id, code, message, at)
     SELECT id, ?, ?, ?, ? FROM passes WHERE id = ? AND org_id = ? AND mode = ? AND template_id = ?
     ON CONFLICT (pass_id) DO UPDATE SET
       release_id = excluded.release_id, code = excluded.code, message = excluded.message, at = excluded.at`,
    [
      input.releaseId,
      input.code,
      input.message.slice(0, 200),
      input.at,
      input.passId,
      input.orgId,
      input.mode,
      input.templateId,
    ],
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

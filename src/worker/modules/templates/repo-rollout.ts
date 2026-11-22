import { all, first, run } from '../../platform/db.ts';
import {
  type ImpactInput,
  impactArgs,
  MOVES_WITH_RELEASE,
  versionJoins,
} from './repo-release-impact.ts';

/** Active passes of the org on the template, in the mode (quarantined test data is not a pass). */
export async function countActivePasses(
  db: D1Database,
  input: { templateId: string; orgId: string; mode: string },
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM passes
     WHERE template_id = ? AND org_id = ? AND mode = ? AND status = 'active' AND deleted_at IS NULL
       AND test_data_quarantined = 0`,
    [input.templateId, input.orgId, input.mode],
  );
  return row?.n ?? 0;
}

/**
 * Passes the cron would move that stayed behind: those with a recorded failure for `releaseId`
 * and, when the rebuild is over (`settled`), the others too. Recorded ones come first.
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

/** Passes still on their way, by the version they are on (those with a recorded failure are left out). */
export async function updatingByVersion(
  db: D1Database,
  input: ImpactInput & { releaseId: string },
): Promise<{ version: string; n: number }[]> {
  return all<{ version: string; n: number }>(
    db,
    `SELECT p.template_version AS version, COUNT(*) AS n FROM passes p ${versionJoins}
     LEFT JOIN template_rollout_failures f ON f.pass_id = p.id AND f.release_id = ?
     WHERE ${MOVES_WITH_RELEASE} AND f.pass_id IS NULL
     GROUP BY p.template_version ORDER BY n DESC LIMIT 6`,
    [input.version, input.releaseId, input.templateId, input.orgId, input.mode, input.version],
  );
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

/** The rebuilds that carry this release in this org and mode (their snapshots name the release). */
export async function rebuildsOf(
  db: D1Database,
  input: { templateId: string; orgId: string; mode: string; releaseId: string },
): Promise<{ n: number; open: number; latestId: string | null }> {
  const where = `FROM workflow_runs w JOIN workflow_release_snapshots s ON s.instance_id = w.instance_id
     WHERE w.kind = 'bulk_reissue' AND s.org_id = ? AND s.mode = ? AND s.template_id = ? AND s.release_id = ?`;
  const args = [input.orgId, input.mode, input.templateId, input.releaseId];
  const row = await first<{ n: number; open: number | null; latest: string | null }>(
    db,
    `SELECT COUNT(*) AS n,
       SUM(CASE WHEN w.status IN ('queued', 'running') THEN 1 ELSE 0 END) AS open,
       (SELECT w.instance_id ${where} ORDER BY w.started_at DESC, w.instance_id DESC LIMIT 1) AS latest
     ${where}`,
    [...args, ...args],
  );
  return { n: row?.n ?? 0, open: row?.open ?? 0, latestId: row?.latest ?? null };
}

/** Whether a Tell holders message was already created for this release (its idempotency key exists). */
export async function tellSent(
  db: D1Database,
  input: { orgId: string; mode: string; releaseId: string },
): Promise<boolean> {
  // The key is `broadcast-create:<mode>:<principal>:rollout-tell:<release>`; the principal varies.
  const tail = `:rollout-tell:${input.releaseId}`;
  const row = await first<{ n: number }>(
    db,
    `SELECT 1 AS n FROM idempotency_keys
     WHERE org_id = ? AND key LIKE ? AND substr(key, -?) = ? LIMIT 1`,
    [input.orgId, `broadcast-create:${input.mode}:%`, tail.length, tail],
  );
  return row !== null && row !== undefined;
}

import { first } from '../../platform/db.ts';

export interface ImpactInput {
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
  AND p.status = 'active' AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
  AND p.template_version != ?
  AND (pinned.build_key IS NULL OR target.build_key IS NULL OR pinned.build_key != target.build_key)`;

export const versionJoins = `
  LEFT JOIN template_versions pinned ON pinned.template_id = p.template_id AND pinned.version = p.template_version
  LEFT JOIN template_versions target ON target.template_id = p.template_id AND target.version = ?`;

export const impactArgs = (i: ImpactInput) => [
  i.version,
  i.templateId,
  i.orgId,
  i.mode,
  i.version,
  i.limit,
];

/** Passes the release would move (what the cron moves), counted up to `limit`. */
export async function countPassesNotOnVersion(db: D1Database, input: ImpactInput): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM passes p ${versionJoins}
       WHERE ${MOVES_WITH_RELEASE}
       LIMIT ?)`,
    impactArgs(input),
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
    impactArgs(input),
  );
  return row?.n ?? 0;
}

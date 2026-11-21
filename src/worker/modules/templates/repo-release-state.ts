import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';
import { reviews } from './repo-sole-reviewer.ts';

/** Candidates of one Apple scope that an approved release already used. */
export async function releasedCandidateIds(
  db: D1Database,
  templateId: string,
  orgId: string,
  mode: Mode,
): Promise<Set<string>> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT DISTINCT candidate_id AS id FROM template_releases
     WHERE template_id = ? AND org_id = ? AND mode = ? AND provider = 'apple'
       AND source = 'approved' AND candidate_id IS NOT NULL`,
    [templateId, orgId, mode],
  );
  return new Set(rows.map((r) => r.id));
}

/** The user holds an active review-capable membership: the caller half of the `sole` rule. */
export async function isActiveReviewer(
  db: D1Database,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM org_memberships m
     WHERE m.org_id = ? AND m.user_id = ? AND m.revoked_at IS NULL AND ${reviews('m')}`,
    [orgId, userId],
  );
  return (row?.n ?? 0) > 0;
}

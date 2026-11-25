import { all, first } from '../../platform/db.ts';
import { rolesGranting } from '../orgs/access.ts';
import { APPLE_ADAPTER_REVISION, AUDIENCE_POLICY_REVISION } from './release-content.ts';

/**
 * The roles whose membership grants `templates:review`. Migration 0093 repeats the list: a role
 * change needs a new migration (a test compares them).
 */
export const REVIEW_ROLES = `(${rolesGranting('templates:review')
  .map((role) => `'${role}'`)
  .join(', ')})`;
/**
 * Disabled users still count: disabling sets no `revoked_at`, so filtering on status would let a
 * self-approval through while a reviewer is disabled, then re-enabled.
 */
export const reviews = (m: string) =>
  `EXISTS (SELECT 1 FROM json_each(${m}.roles) r WHERE r.value IN ${REVIEW_ROLES})`;

/**
 * The commit-time condition of a sole approval, evaluated inside the grant's batch: the reviewer is
 * the org's only active member with review rights. The `template_approvals_insert` trigger repeats it.
 */
export function soleReviewerSql(orgSql: string, reviewer: () => string): string {
  return `((SELECT count(*) FROM org_memberships m
      WHERE m.org_id = ${orgSql} AND m.revoked_at IS NULL AND ${reviews('m')}) = 1
    AND EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = ${orgSql} AND m.user_id = ${reviewer()}
      AND m.revoked_at IS NULL AND ${reviews('m')}))`;
}

export async function countEligibleReviewers(db: D1Database, orgId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM org_memberships m
     WHERE m.org_id = ? AND m.revoked_at IS NULL AND ${reviews('m')}`,
    [orgId],
  );
  return row?.n ?? 0;
}

/** A review-capable membership made after `since`: it voids an earlier `sole` approval at release. */
export async function reviewerAddedSince(
  db: D1Database,
  orgId: string,
  since: number,
): Promise<boolean> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM org_memberships m
     WHERE m.org_id = ? AND m.created_at > ? AND ${reviews('m')}`,
    [orgId, since],
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Versions whose newest approved Test release is what a new Live candidate would be: the same
 * content and the current adapter and audience policy revisions.
 */
export async function testReleasedVersions(
  db: D1Database,
  templateId: string,
  orgId: string,
): Promise<string[]> {
  const rows = await all<{ version: string }>(
    db,
    `SELECT r.version FROM template_releases r
     JOIN template_version_hashes h ON h.template_id = r.template_id AND h.version = r.version
     WHERE r.template_id = ? AND r.org_id = ? AND r.mode = 'test' AND r.provider = 'apple'
       AND r.source = 'approved' AND r.content_hash = h.content_hash
       AND r.adapter_revision = ? AND r.audience_policy_revision = ?
       AND r.generation = (SELECT MAX(x.generation) FROM template_releases x
         WHERE x.template_id = r.template_id AND x.org_id = r.org_id AND x.mode = 'test'
           AND x.provider = 'apple' AND x.version = r.version AND x.source = 'approved')
     GROUP BY r.version`,
    [templateId, orgId, APPLE_ADAPTER_REVISION, AUDIENCE_POLICY_REVISION],
  );
  return rows.map((r) => r.version);
}

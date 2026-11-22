import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';
import { knownEmailSql } from '../../platform/known-email-sql.ts';
import { APPLE_ADAPTER_REVISION, AUDIENCE_POLICY_REVISION } from './release-content.ts';
import { reviews } from './repo-sole-reviewer.ts';

export interface OpenReviewRow {
  templateId: string;
  templateName: string;
  version: string;
  authorId: string;
  requestedAt: number;
}

/**
 * Live candidates still waiting for a peer: unreleased, no independent approval, and for the template's
 * newest version, so a request superseded by a newer version drops out. One row per template.
 */
const OPEN = `FROM template_candidates c
  JOIN templates t ON t.id = c.template_id
  WHERE c.org_id = ? AND c.mode = ? AND c.provider = 'apple'
    AND t.status = 'active' AND t.origin = 'uploaded'
    AND c.adapter_revision = ? AND c.audience_policy_revision = ?
    AND c.version = (SELECT v.version FROM template_versions v WHERE v.template_id = c.template_id
      ORDER BY v.created_at DESC, v.version DESC LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM template_releases r WHERE r.candidate_id = c.id AND r.source = 'approved')
    AND NOT EXISTS (SELECT 1 FROM template_approvals a WHERE a.candidate_id = c.id
      AND a.kind = 'peer' AND a.candidate_hash = c.candidate_hash
      AND a.reviewer_id != c.author_id AND a.reviewer_id IS NOT c.version_author_id)`;

/** Whether template alias `t` has a Live candidate waiting for a peer: the list's `openReview`. Revisions are constants. */
export const OPEN_REVIEW_SQL = `EXISTS (SELECT 1 FROM template_candidates c
  WHERE c.template_id = t.id AND c.org_id = t.org_id AND c.mode = 'live' AND c.provider = 'apple'
    AND t.status = 'active' AND t.origin = 'uploaded'
    AND c.adapter_revision = ${Number(APPLE_ADAPTER_REVISION)}
    AND c.audience_policy_revision = ${Number(AUDIENCE_POLICY_REVISION)}
    AND c.version = (SELECT v.version FROM template_versions v WHERE v.template_id = c.template_id
      ORDER BY v.created_at DESC, v.version DESC LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM template_releases r WHERE r.candidate_id = c.id AND r.source = 'approved')
    AND NOT EXISTS (SELECT 1 FROM template_approvals a WHERE a.candidate_id = c.id
      AND a.kind = 'peer' AND a.candidate_hash = c.candidate_hash
      AND a.reviewer_id != c.author_id AND a.reviewer_id IS NOT c.version_author_id))`;

/** Open requests the caller did not write, oldest request per template, newest first. */
export async function listOpenReviews(
  db: D1Database,
  orgId: string,
  mode: Mode,
  userId: string | null,
  after: { at: number; id: string } | null,
  limit: number,
): Promise<OpenReviewRow[]> {
  const rows = await all<{
    template_id: string;
    name: string;
    version: string;
    author_id: string;
    at: number;
  }>(
    db,
    `SELECT * FROM (
       SELECT c.template_id, t.name, c.version, c.author_id, MIN(c.created_at) AS at ${OPEN}
         AND c.author_id IS NOT ? AND c.version_author_id IS NOT ?
       GROUP BY c.template_id
     ) WHERE (? IS NULL OR at < ? OR (at = ? AND template_id < ?))
     ORDER BY at DESC, template_id DESC LIMIT ?`,
    [
      orgId,
      mode,
      APPLE_ADAPTER_REVISION,
      AUDIENCE_POLICY_REVISION,
      userId,
      userId,
      after?.at ?? null,
      after?.at ?? null,
      after?.at ?? null,
      after?.id ?? '',
      limit,
    ],
  );
  return rows.map((r) => ({
    templateId: r.template_id,
    templateName: r.name,
    version: r.version,
    authorId: r.author_id,
    requestedAt: r.at,
  }));
}

/** Verified emails of the org's active reviewers except `exceptUserId`. */
export async function reviewerEmails(
  db: D1Database,
  orgId: string,
  exceptUserId: string,
): Promise<string[]> {
  const rows = await all<{ email: string | null }>(
    db,
    `SELECT DISTINCT ${knownEmailSql('u.primary_email')} AS email FROM org_memberships m
     JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.org_id = ? AND m.revoked_at IS NULL AND m.user_id != ? AND ${reviews('m')}`,
    [orgId, exceptUserId],
  );
  return rows.flatMap((r) => (r.email ? [r.email] : []));
}

/** Versions other than `version` that still have an open Live request: the ones a new request supersedes. */
export async function olderOpenVersions(
  db: D1Database,
  templateId: string,
  orgId: string,
  version: string,
): Promise<string[]> {
  const rows = await all<{ version: string }>(
    db,
    `SELECT DISTINCT c.version FROM template_candidates c
     WHERE c.template_id = ? AND c.org_id = ? AND c.mode = 'live' AND c.provider = 'apple'
       AND c.version != ?
       AND NOT EXISTS (SELECT 1 FROM template_releases r WHERE r.candidate_id = c.id AND r.source = 'approved')
       AND NOT EXISTS (SELECT 1 FROM template_approvals a WHERE a.candidate_id = c.id AND a.kind = 'peer')`,
    [templateId, orgId, version],
  );
  return rows.map((r) => r.version);
}

/**
 * The newest saved version that still has an unreleased candidate, or null: a request for any older
 * version was replaced by it.
 */
export async function newestRequestedVersion(
  db: D1Database,
  templateId: string,
  orgId: string,
): Promise<string | null> {
  const row = await first<{ version: string }>(
    db,
    `SELECT v.version FROM template_versions v
     WHERE v.template_id = ? AND EXISTS (SELECT 1 FROM template_candidates c
       WHERE c.template_id = v.template_id AND c.version = v.version AND c.org_id = ?
         AND c.provider = 'apple'
         AND NOT EXISTS (SELECT 1 FROM template_releases r WHERE r.candidate_id = c.id AND r.source = 'approved'))
     ORDER BY v.created_at DESC, v.version DESC LIMIT 1`,
    [templateId, orgId],
  );
  return row?.version ?? null;
}

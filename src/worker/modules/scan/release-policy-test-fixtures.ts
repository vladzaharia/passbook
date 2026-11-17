import { first, run, stmt } from '../../platform/db.ts';
import { candidateHash } from '../templates/release-content.ts';
import { getCandidate } from '../templates/repo-releases.ts';
import type { ScanKit } from './test-kit.ts';

/**
 * Positive control for the same-version rule: reissue the pass under a release written by an older
 * adapter (other capabilities; internally consistent, append-only), so the next release of the same
 * version differs from the pass's own in a disclosure-relevant field. Revisions cannot differ
 * (a release never lowers them, and a head must be current), so capabilities stand in. A republish
 * (`approveAppleRelease`) before this call is identical to the pass's own release.
 */
const OLDER_CAPABILITIES = ['apple-passkit', 'apple-passkit-v0'];
const OLDER_CAPABILITIES_JSON = JSON.stringify(OLDER_CAPABILITIES);

export async function issueUnderOlderAdapter(kit: ScanKit, passId: string): Promise<string> {
  const own = await first<{ releaseId: string; candidateId: string; approvalId: string }>(
    kit.env.DB,
    `SELECT r.id AS releaseId, r.candidate_id AS candidateId, r.approval_id AS approvalId
       FROM passes p JOIN template_releases r ON r.id=p.release_id WHERE p.id=?`,
    [passId],
  );
  if (!own) throw new Error('The pass has no issued release.');
  const candidate = await getCandidate(kit.env.DB, own.candidateId);
  if (!candidate) throw new Error('The issued release has no candidate.');
  const now = kit.clock.now() + 1;
  const [candidateId, approvalId, releaseId] = [kit.fx.ids.id(), kit.fx.ids.id(), kit.fx.ids.id()];
  const digest = await candidateHash({
    templateId: candidate.templateId,
    orgId: candidate.orgId,
    mode: candidate.mode,
    provider: candidate.provider,
    version: candidate.version,
    contentHash: candidate.contentHash,
    adapterRevision: candidate.adapterRevision,
    adapterCapabilities: OLDER_CAPABILITIES,
    audiencePolicyRevision: candidate.audiencePolicyRevision,
    authorId: candidate.authorId,
    versionAuthorId: candidate.versionAuthorId,
    createdAt: now,
  });
  await kit.env.DB.batch([
    stmt(
      kit.env.DB,
      `INSERT INTO template_candidates
        (id, template_id, org_id, mode, provider, version, candidate_hash, content_hash,
         adapter_revision, adapter_capabilities, audience_policy_revision, author_id,
         version_author_id, created_at)
       SELECT ?, template_id, org_id, mode, provider, version, ?, content_hash,
         adapter_revision, ?, audience_policy_revision, author_id, version_author_id, ?
       FROM template_candidates WHERE id = ?`,
      [candidateId, digest, OLDER_CAPABILITIES_JSON, now, own.candidateId],
    ),
    stmt(
      kit.env.DB,
      `INSERT INTO template_approvals (id, candidate_id, candidate_hash, reviewer_id, created_at)
       SELECT ?, ?, ?, reviewer_id, ? FROM template_approvals WHERE id = ?`,
      [approvalId, candidateId, digest, now, own.approvalId],
    ),
    stmt(
      kit.env.DB,
      `INSERT INTO template_releases
        (id, template_id, org_id, mode, provider, generation, version, candidate_hash,
         content_hash, adapter_revision, adapter_capabilities, audience_policy_revision,
         source, action, candidate_id, approval_id, previous_release_id,
         rollback_of_release_id, created_by, created_at)
       SELECT ?, template_id, org_id, mode, provider,
         (SELECT MAX(generation) FROM template_releases m WHERE m.template_id=r.template_id
           AND m.org_id IS r.org_id AND m.mode=r.mode AND m.provider=r.provider) + 1,
         version, ?, content_hash, adapter_revision, ?, audience_policy_revision,
         'approved', 'release', ?, ?,
         (SELECT x.id FROM template_releases x WHERE x.template_id=r.template_id
           AND x.org_id IS r.org_id AND x.mode=r.mode AND x.provider=r.provider
           ORDER BY x.generation DESC LIMIT 1),
         NULL, created_by, ?
       FROM template_releases r WHERE id = ?`,
      [releaseId, digest, OLDER_CAPABILITIES_JSON, candidateId, approvalId, now, own.releaseId],
    ),
  ]);
  await run(kit.env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [releaseId, passId]);
  return releaseId;
}

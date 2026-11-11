import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';
import { effectiveReleaseIdSql, type ReleaseScopeSql } from './repo-release-heads.ts';

export type { ReleaseScopeSql } from './repo-release-heads.ts';
export {
  activeReleaseIdSql,
  activeReleasePredicate,
} from './repo-releases-active.ts';

export type ReleaseProvider = 'apple' | 'google' | 'samsung';
export interface ReleaseScope {
  templateId: string;
  orgId: string | null;
  mode: Mode;
  provider: ReleaseProvider;
}
export interface CandidateRow extends ReleaseScope {
  id: string;
  version: string;
  candidateHash: string;
  contentHash: string;
  adapterRevision: number;
  adapterCapabilities: string[];
  audiencePolicyRevision: number;
  authorId: string;
  versionAuthorId: string | null;
  createdAt: number;
}
export interface ApprovalRow {
  id: string;
  candidateId: string;
  candidateHash: string;
  reviewerId: string;
  createdAt: number;
}
export interface ReleaseRow extends ReleaseScope {
  id: string;
  generation: number;
  version: string;
  candidateHash: string;
  contentHash: string;
  adapterRevision: number;
  adapterCapabilities: string[];
  audiencePolicyRevision: number;
  source: 'approved' | 'system' | 'legacy';
  action: 'release' | 'rollback' | 'system' | 'legacy';
  candidateId: string | null;
  approvalId: string | null;
  previousReleaseId: string | null;
  rollbackOfReleaseId: string | null;
  createdBy: string | null;
  createdAt: number;
}

const candidateColumns = `id, template_id AS templateId, org_id AS orgId, mode, provider, version,
  candidate_hash AS candidateHash, content_hash AS contentHash, adapter_revision AS adapterRevision,
  adapter_capabilities AS adapterCapabilities, audience_policy_revision AS audiencePolicyRevision,
  author_id AS authorId, version_author_id AS versionAuthorId, created_at AS createdAt`;
const approvalColumns = `id, candidate_id AS candidateId, candidate_hash AS candidateHash,
  reviewer_id AS reviewerId, created_at AS createdAt`;
const releaseColumns = `id, template_id AS templateId, org_id AS orgId, mode, provider, generation,
  version, candidate_hash AS candidateHash, content_hash AS contentHash,
  adapter_revision AS adapterRevision, adapter_capabilities AS adapterCapabilities,
  audience_policy_revision AS audiencePolicyRevision, source, action, candidate_id AS candidateId,
  approval_id AS approvalId, previous_release_id AS previousReleaseId,
  rollback_of_release_id AS rollbackOfReleaseId, created_by AS createdBy, created_at AS createdAt`;
type Stored<T> = Omit<T, 'adapterCapabilities'> & { adapterCapabilities: string };
function row<T extends { adapterCapabilities: string[] }>(value: Stored<T>): T {
  return { ...value, adapterCapabilities: JSON.parse(value.adapterCapabilities) as string[] } as T;
}
const scopeValues = (s: ReleaseScope): SqlValue[] => [s.templateId, s.orgId, s.mode, s.provider];

export async function getCandidate(db: D1Database, id: string): Promise<CandidateRow | null> {
  const found = await first<Stored<CandidateRow>>(
    db,
    `SELECT ${candidateColumns} FROM template_candidates WHERE id = ?`,
    [id],
  );
  return found ? row<CandidateRow>(found) : null;
}
export async function listCandidates(db: D1Database, scope: ReleaseScope): Promise<CandidateRow[]> {
  const rows = await all<Stored<CandidateRow>>(
    db,
    `SELECT ${candidateColumns} FROM template_candidates
     WHERE template_id = ? AND org_id IS ? AND mode = ? AND provider = ?
     ORDER BY created_at DESC, id DESC`,
    scopeValues(scope),
  );
  return rows.map((value) => row<CandidateRow>(value));
}
export function getApproval(db: D1Database, id: string): Promise<ApprovalRow | null> {
  return first<ApprovalRow>(db, `SELECT ${approvalColumns} FROM template_approvals WHERE id = ?`, [
    id,
  ]);
}
export function listApprovals(db: D1Database, candidateId: string): Promise<ApprovalRow[]> {
  return all<ApprovalRow>(
    db,
    `SELECT ${approvalColumns} FROM template_approvals
     WHERE candidate_id = ? ORDER BY created_at DESC, id DESC`,
    [candidateId],
  );
}
export async function getRelease(db: D1Database, id: string): Promise<ReleaseRow | null> {
  const sql = `SELECT ${releaseColumns} FROM template_releases WHERE id = ?`;
  const found = await first<Stored<ReleaseRow>>(db, sql, [id]);
  return found ? row<ReleaseRow>(found) : null;
}
export async function listReleases(db: D1Database, scope: ReleaseScope): Promise<ReleaseRow[]> {
  const rows = await all<Stored<ReleaseRow>>(
    db,
    `SELECT ${releaseColumns} FROM template_releases
     WHERE template_id = ? AND org_id IS ? AND mode = ? AND provider = ? ORDER BY generation DESC`,
    scopeValues(scope),
  );
  return rows.map((value) => row<ReleaseRow>(value));
}
export async function getLatestRelease(
  db: D1Database,
  scope: ReleaseScope,
): Promise<ReleaseRow | null> {
  const found = await first<Stored<ReleaseRow>>(
    db,
    `SELECT ${releaseColumns} FROM template_releases
     WHERE template_id = ? AND org_id IS ? AND mode = ? AND provider = ?
     ORDER BY generation DESC LIMIT 1`,
    scopeValues(scope),
  );
  return found ? row<ReleaseRow>(found) : null;
}

export interface IssuedReleaseSql {
  releaseIdSql: string;
  versionSql: string;
  generationSql?: string;
  candidateHashSql?: string;
}

/** Validate immutable Apple issuance provenance without requiring the release to remain the head. */
export function issuedReleasePredicateSql(
  binding: IssuedReleaseSql,
  scope: ReleaseScopeSql,
): string {
  return `EXISTS (
    SELECT 1 FROM template_releases issued
    JOIN templates owner ON owner.id = issued.template_id
    JOIN template_versions version ON version.template_id = issued.template_id AND version.version = issued.version
    WHERE (issued.id = (${binding.releaseIdSql}) AND issued.template_id = (${scope.templateIdSql})
      AND issued.mode = (${scope.modeSql}) AND issued.provider = (${scope.providerSql}))
      AND (issued.provider = 'apple' AND issued.version = (${binding.versionSql})
        ${binding.generationSql ? `AND issued.generation = (${binding.generationSql})` : ''}
        ${binding.candidateHashSql ? `AND issued.candidate_hash = (${binding.candidateHashSql})` : ''})
      AND (
        ((issued.source = 'system' AND issued.action = 'system' AND owner.origin = 'baked'
            AND issued.org_id IS owner.org_id)
          AND ((issued.org_id IS (${scope.orgIdSql}) OR (issued.org_id IS NULL AND owner.org_id IS NULL))
            AND issued.candidate_id IS NULL AND issued.approval_id IS NULL
            AND issued.rollback_of_release_id IS NULL)
          AND issued.created_by IS NULL)
        OR
        ((issued.source = 'approved' AND issued.action IN ('release', 'rollback')
            AND owner.origin = 'uploaded' AND issued.org_id IS NOT NULL)
          AND (issued.org_id IS (${scope.orgIdSql})
            AND (owner.org_id IS NULL OR owner.org_id = issued.org_id)
            AND issued.created_by IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM template_candidates candidate
            JOIN template_approvals approval ON approval.candidate_id = candidate.id
            WHERE (((candidate.id = issued.candidate_id AND approval.id = issued.approval_id)
                AND (candidate.template_id = issued.template_id AND candidate.org_id IS issued.org_id))
              AND ((candidate.mode = issued.mode AND candidate.provider = issued.provider)
                AND (candidate.version = issued.version AND candidate.candidate_hash = issued.candidate_hash)))
              AND (((approval.candidate_hash = candidate.candidate_hash
                  AND candidate.content_hash = issued.content_hash)
                AND (candidate.adapter_revision = issued.adapter_revision
                  AND candidate.adapter_capabilities = issued.adapter_capabilities))
              AND ((candidate.audience_policy_revision = issued.audience_policy_revision
                  AND version.created_by IS candidate.version_author_id)
                AND (approval.reviewer_id != candidate.author_id
                  AND (candidate.version_author_id IS NULL OR approval.reviewer_id != candidate.version_author_id))))
          ))
        OR
        (issued.source = 'legacy' AND issued.action = 'legacy' AND owner.origin = 'uploaded'
          AND issued.org_id IS NOT NULL AND issued.org_id IS (${scope.orgIdSql})
          AND (owner.org_id IS NULL OR owner.org_id = issued.org_id))
      )
  )`;
}

/** Legacy maintenance is allowed only when the effective scope has no release history at all. */
export function noScopedReleaseSql(scope: ReleaseScopeSql): string {
  return `NOT EXISTS (
    SELECT 1 FROM template_releases historic
    JOIN templates owner ON owner.id = historic.template_id
    WHERE historic.template_id = (${scope.templateIdSql})
      AND historic.mode = (${scope.modeSql}) AND historic.provider = (${scope.providerSql})
      AND (historic.org_id IS (${scope.orgIdSql})
        OR (historic.org_id IS NULL AND owner.org_id IS NULL AND owner.origin = 'baked'))
  )`;
}
export async function getActiveRelease(
  db: D1Database,
  scope: ReleaseScope,
): Promise<ReleaseRow | null> {
  const select = effectiveReleaseIdSql({
    templateIdSql: 's.template_id',
    orgIdSql: 's.org_id',
    modeSql: 's.mode',
    providerSql: 's.provider',
  });
  const found = await first<Stored<ReleaseRow>>(
    db,
    `SELECT ${releaseColumns} FROM template_releases
     WHERE id = (SELECT (${select}) FROM (SELECT ? AS template_id, ? AS org_id, ? AS mode, ? AS provider) s)`,
    scopeValues(scope),
  );
  return found ? row<ReleaseRow>(found) : null;
}

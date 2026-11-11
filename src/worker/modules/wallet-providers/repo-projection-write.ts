import type { Mode } from '../../../shared/contracts/common.ts';
import { stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type { TemplateAuthority } from '../templates/access.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { templateAuthorityPredicate } from '../templates/repo-authority.ts';
import type { ApprovalRow } from '../templates/repo-releases.ts';
import type { WalletCredentialKeysetProof } from './instance-types.ts';
import { projectionPolicy } from './projection-contract.ts';
import type { ProjectionCandidate } from './repo-projection-store.ts';
import { samsungProjectionEvidencePredicateSql } from './repo-samsung-verification.ts';

/** SQL predicates refer only to immutable, trusted aliases chosen by these repository methods. */
function currentSourceAndAccount(alias: string): string {
  return `EXISTS (SELECT 1 FROM template_provider_apple_sources source
      JOIN template_versions version ON version.template_id = source.template_id AND version.version = source.version
      JOIN wallet_provider_accounts account ON account.id = ${alias}.provider_account_id
        AND account.org_id = ${alias}.org_id AND account.mode = ${alias}.mode AND account.provider = ${alias}.provider
        AND account.revision = ${alias}.provider_account_revision AND account.credential_id IS NOT NULL
        AND account.revoked_at IS NULL
      WHERE source.id = ${alias}.source_release_id AND source.template_id = ${alias}.template_id
        AND source.mode = ${alias}.mode AND source.version = ${alias}.version
        AND (source.org_id = ${alias}.org_id OR (source.org_id IS NULL AND source.origin = 'baked' AND source.template_org_id IS NULL))
        AND source.generation = ${alias}.source_release_generation AND source.candidate_hash = ${alias}.source_release_hash
        AND source.content_hash = ${alias}.content_hash AND version.created_by IS ${alias}.version_author_id)`;
}
function guard(
  authority: TemplateAuthority,
  capability: 'templates:author' | 'templates:review' | 'templates:publish',
  orgSql: string,
  mode: Mode,
  now: number,
) {
  const valid =
    authority.kind === 'session' && authority.capability === capability && authority.mode === mode;
  const predicate = templateAuthorityPredicate(authority, orgSql, now);
  return { sql: `? = 1 AND (${predicate.sql})`, params: [valid ? 1 : 0, ...predicate.params] };
}

export function insertProjectionCandidateStmt(
  db: D1Database,
  c: ProjectionCandidate,
  authority: TemplateAuthority,
  now: number,
  proof: WalletCredentialKeysetProof,
): D1PreparedStatement {
  const auth = guard(authority, 'templates:author', 'source_scope.org_id', c.mode, now);
  const policy = projectionPolicy(c.provider);
  return stmt(
    db,
    `INSERT INTO template_candidates (id, template_id, org_id, mode, provider, version,
    candidate_hash, content_hash, adapter_revision, adapter_capabilities, audience_policy_revision,
    author_id, version_author_id, created_at, source_release_id, source_release_generation, source_release_hash,
    provider_account_id, provider_account_revision, provider_identity_hash, projection_json, credential_keyset_commitment)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM (SELECT ? AS org_id) source_scope
    JOIN template_provider_apple_sources source ON source.id = ? AND source.template_id = ?
      AND source.mode = ? AND source.version = ? AND source.generation = ? AND source.candidate_hash = ?
      AND source.content_hash = ? AND (source.org_id = source_scope.org_id
        OR (source.org_id IS NULL AND source.origin = 'baked' AND source.template_org_id IS NULL))
    JOIN template_versions v ON v.template_id = source.template_id AND v.version = source.version AND v.created_by IS ?
    JOIN wallet_provider_accounts account ON account.id = ? AND account.org_id = source_scope.org_id
      AND account.mode = ? AND account.provider = ? AND account.revision = ?
      AND account.credential_id IS NOT NULL
      AND account.revoked_at IS NULL
    WHERE ? = ? AND ? = ? AND ? = ? AND ? = ? AND ? = ?
      AND (${credentialRefKeysetSql}) AND (${auth.sql})`,
    [
      c.id,
      c.templateId,
      c.orgId,
      c.mode,
      c.provider,
      c.version,
      c.candidateHash,
      c.contentHash,
      c.adapterRevision,
      JSON.stringify(c.adapterCapabilities),
      c.audiencePolicyRevision,
      c.authorId,
      c.versionAuthorId,
      c.createdAt,
      c.sourceReleaseId,
      c.sourceReleaseGeneration,
      c.sourceReleaseHash,
      c.accountId,
      c.accountRevision,
      c.providerIdentityHash,
      canonicalJson(c.projection),
      c.credentialKeysetCommitment,
      c.orgId,
      c.sourceReleaseId,
      c.templateId,
      c.mode,
      c.version,
      c.sourceReleaseGeneration,
      c.sourceReleaseHash,
      c.contentHash,
      c.versionAuthorId,
      c.accountId,
      c.mode,
      c.provider,
      c.accountRevision,
      c.authorId,
      authority.userId,
      c.adapterRevision,
      policy.adapterRevision,
      JSON.stringify(c.adapterCapabilities),
      JSON.stringify(policy.adapterCapabilities),
      c.audiencePolicyRevision,
      policy.audiencePolicyRevision,
      c.credentialKeysetCommitment,
      proof?.credentialKeysetCommitment,
      proof?.credentialKeysetCommitment,
      ...auth.params,
    ],
  );
}

export function insertProjectionApprovalStmt(
  db: D1Database,
  a: ApprovalRow,
  c: ProjectionCandidate,
  authority: TemplateAuthority,
  now: number,
  proof: WalletCredentialKeysetProof,
): D1PreparedStatement {
  const auth = guard(authority, 'templates:review', 'c.org_id', c.mode, now);
  const policy = projectionPolicy(c.provider);
  return stmt(
    db,
    `INSERT INTO template_approvals
    (id, candidate_id, candidate_hash, reviewer_id, created_at, credential_keyset_commitment)
    SELECT ?, c.id, c.candidate_hash, ?, ?, c.credential_keyset_commitment FROM template_candidates c
    WHERE c.id = ? AND c.org_id = ? AND c.mode = ? AND c.provider = ? AND c.candidate_hash = ?
      AND c.author_id != ? AND (c.version_author_id IS NULL OR c.version_author_id != ?)
      AND ? = ? AND c.adapter_revision = ? AND c.adapter_capabilities = ? AND c.audience_policy_revision = ?
      AND c.credential_keyset_commitment = ?
      AND (${currentSourceAndAccount('c')}) AND (${credentialRefKeysetSql}) AND (${auth.sql})`,
    [
      a.id,
      a.reviewerId,
      a.createdAt,
      c.id,
      c.orgId,
      c.mode,
      c.provider,
      a.candidateHash,
      a.reviewerId,
      a.reviewerId,
      a.reviewerId,
      authority.userId,
      policy.adapterRevision,
      JSON.stringify(policy.adapterCapabilities),
      policy.audiencePolicyRevision,
      proof?.credentialKeysetCommitment,
      proof?.credentialKeysetCommitment,
      ...auth.params,
    ],
  );
}

export function insertProjectionReleaseStmt(
  db: D1Database,
  input: WalletCredentialKeysetProof & {
    id: string;
    candidate: ProjectionCandidate;
    approval: ApprovalRow;
    authority: TemplateAuthority;
    expectedGeneration: number;
    expectedReleaseId: string | null;
    action: 'release' | 'rollback';
    targetReleaseId: string | null;
    now: number;
  },
): D1PreparedStatement {
  const { candidate: c, approval: a, authority } = input;
  const auth = guard(authority, 'templates:publish', 'c.org_id', c.mode, input.now);
  const policy = projectionPolicy(c.provider);
  const same = `r.template_id = c.template_id AND r.org_id = c.org_id AND r.mode = c.mode AND r.provider = c.provider`;
  return stmt(
    db,
    `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation,
    version, candidate_hash, content_hash, adapter_revision, adapter_capabilities, audience_policy_revision,
    source, action, candidate_id, approval_id, previous_release_id, rollback_of_release_id, created_by, created_at,
    credential_keyset_commitment)
    SELECT ?, c.template_id, c.org_id, c.mode, c.provider, ? + 1, c.version, c.candidate_hash, c.content_hash,
      c.adapter_revision, c.adapter_capabilities, c.audience_policy_revision, 'approved', ?, c.id, a.id, ?, ?, ?, ?,
      c.credential_keyset_commitment
    FROM template_candidates c JOIN template_approvals a ON a.candidate_id = c.id AND a.candidate_hash = c.candidate_hash
    CROSS JOIN (SELECT ? AS now_ms) proof_clock
    WHERE c.id = ? AND a.id = ? AND c.org_id = ? AND c.mode = ? AND c.provider = ? AND c.candidate_hash = ?
      AND c.credential_keyset_commitment = ? AND a.credential_keyset_commitment = c.credential_keyset_commitment
      AND a.reviewer_id != c.author_id AND (c.version_author_id IS NULL OR a.reviewer_id != c.version_author_id)
      AND c.adapter_revision = ? AND c.adapter_capabilities = ? AND c.audience_policy_revision = ?
      AND c.provider = 'samsung' AND (${samsungProjectionEvidencePredicateSql('c', 'proof_clock.now_ms', '?')})
      AND ? = ? AND (${currentSourceAndAccount('c')}) AND (${auth.sql})
      AND COALESCE((SELECT MAX(r.generation) FROM template_releases r WHERE ${same}), 0) = ?
      AND (SELECT r.id FROM template_releases r WHERE ${same} ORDER BY r.generation DESC LIMIT 1) IS ?
      AND ((? = 'release' AND ? IS NULL AND NOT EXISTS (SELECT 1 FROM template_releases r WHERE r.candidate_id = c.id))
        OR (? = 'rollback' AND EXISTS (SELECT 1 FROM template_releases r WHERE r.id = ? AND ${same}
          AND r.generation < ? AND r.candidate_id = c.id AND r.approval_id = a.id AND r.candidate_hash = c.candidate_hash
          AND r.credential_keyset_commitment = c.credential_keyset_commitment)))`,
    [
      input.id,
      input.expectedGeneration,
      input.action,
      input.expectedReleaseId,
      input.targetReleaseId,
      authority.userId,
      input.now,
      input.now,
      c.id,
      a.id,
      c.orgId,
      c.mode,
      c.provider,
      c.candidateHash,
      input.credentialKeysetCommitment,
      policy.adapterRevision,
      JSON.stringify(policy.adapterCapabilities),
      policy.audiencePolicyRevision,
      input.credentialKeysetCommitment,
      authority.userId,
      authority.userId,
      ...auth.params,
      input.expectedGeneration,
      input.expectedReleaseId,
      input.action,
      input.targetReleaseId,
      input.action,
      input.targetReleaseId,
      input.expectedGeneration,
    ],
  );
}

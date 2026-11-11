import type { Mode } from '../../../shared/contracts/common.ts';
import { first } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { candidateHash } from '../templates/release-content.ts';
import { activeReleaseIdSql } from '../templates/repo-releases.ts';
import type { WalletCredentialKeysetProof } from './instance-types.ts';
import {
  type NativeProjection,
  type NativeProvider,
  SAMSUNG_PROJECTION_POLICY,
} from './projection-contract.ts';
import { getProjectionCandidate, projectionCandidateEnvelope } from './repo-projection-store.ts';
import { samsungProjectionEvidencePredicateSql } from './repo-samsung-verification.ts';

/** Every argument is a trusted SQL expression, never untrusted request text. */
export interface ProjectionReleaseScopeSql {
  releaseIdSql: string;
  orgIdSql: string;
  modeSql: string;
  providerSql: string;
  templateIdSql: string;
  versionSql: string;
  sourceReleaseIdSql: string;
  /** Trusted SQL expression for the original credential-reference keyset commitment. */
  credentialKeysetCommitmentSql: string;
  /** Trusted SQL timestamp expression. Omission is rejected. */
  nowSql?: string;
}

/** Atomic fence for a previously cryptographically verified projection release. */
export function projectionReleaseBindingPredicateSql(scope: ProjectionReleaseScopeSql): string {
  if (!scope.nowSql || !scope.credentialKeysetCommitmentSql)
    throw new Error('A trusted projection evidence clock and credential keyset are required.');
  const nowSql = scope.nowSql;
  const samsung = JSON.stringify(SAMSUNG_PROJECTION_POLICY.adapterCapabilities).replaceAll(
    "'",
    "''",
  );
  const source = activeReleaseIdSql({
    templateIdSql: 'pc.template_id',
    orgIdSql: 'pc.org_id',
    modeSql: 'pc.mode',
    providerSql: "'apple'",
  });
  // Separate SELECT cores keep the expanded Apple view and evidence checks below D1's
  // expression-depth limit, while intersecting only the same captured release.
  return `EXISTS (WITH projection_binding_release AS MATERIALIZED (
    SELECT id, candidate_id FROM template_releases WHERE id = (${scope.releaseIdSql})
  )
  SELECT pr.id FROM projection_binding_release pb
    JOIN template_releases pr ON pr.id = pb.id
    JOIN template_candidates pc ON pc.id = pr.candidate_id
    JOIN template_approvals pa ON pa.id = pr.approval_id AND pa.candidate_id = pc.id
    JOIN template_versions pv ON pv.template_id = pc.template_id AND pv.version = pc.version
    JOIN wallet_provider_accounts paccount ON paccount.id = pc.provider_account_id
      AND paccount.org_id = pc.org_id AND paccount.mode = pc.mode AND paccount.provider = pc.provider
      AND paccount.revision = pc.provider_account_revision AND paccount.credential_id IS NOT NULL
      AND paccount.revoked_at IS NULL
    WHERE (pr.org_id = (${scope.orgIdSql}) AND pr.mode = (${scope.modeSql})
      AND pr.provider = (${scope.providerSql}))
      AND (pr.provider IN ('google', 'samsung') AND pr.template_id = (${scope.templateIdSql})
        AND pr.version = (${scope.versionSql}) AND pc.source_release_id = (${scope.sourceReleaseIdSql}))
      AND (pr.source = 'approved' AND pr.action IN ('release', 'rollback')
        AND pc.template_id = pr.template_id AND pc.org_id = pr.org_id AND pc.mode = pr.mode
        AND pc.provider = pr.provider AND pc.version = pr.version)
      AND (pc.candidate_hash = pr.candidate_hash AND pa.candidate_hash = pc.candidate_hash
        AND pc.credential_keyset_commitment = (${scope.credentialKeysetCommitmentSql})
        AND pr.credential_keyset_commitment = pc.credential_keyset_commitment
        AND pa.credential_keyset_commitment = pc.credential_keyset_commitment)
      AND (pc.content_hash = pr.content_hash AND pc.adapter_revision = pr.adapter_revision
        AND pc.adapter_capabilities = pr.adapter_capabilities
        AND pc.audience_policy_revision = pr.audience_policy_revision)
      AND (pv.created_by IS pc.version_author_id AND pa.reviewer_id != pc.author_id
        AND (pc.version_author_id IS NULL OR pa.reviewer_id != pc.version_author_id)
        AND pr.created_by IS NOT NULL
        AND pc.projection_json IS NOT NULL AND json_valid(pc.projection_json)
        AND json_type(pc.projection_json) = 'object' AND length(pc.provider_identity_hash) = 64)
      AND NOT EXISTS (SELECT 1 FROM template_releases newer WHERE newer.template_id = pr.template_id
        AND newer.org_id = pr.org_id AND newer.mode = pr.mode AND newer.provider = pr.provider
        AND newer.generation > pr.generation)
  INTERSECT
  SELECT pb.id FROM projection_binding_release pb
    JOIN template_candidates pc ON pc.id = pb.candidate_id
    JOIN template_provider_apple_sources ps ON ps.id = pc.source_release_id
    WHERE (ps.template_id = pc.template_id AND ps.mode = pc.mode
      AND ps.version = pc.version AND ps.generation = pc.source_release_generation
      AND ps.candidate_hash = pc.source_release_hash AND ps.content_hash = pc.content_hash)
      AND (ps.org_id = pc.org_id OR (ps.org_id IS NULL AND ps.origin = 'baked' AND ps.template_org_id IS NULL))
  INTERSECT
  SELECT pb.id FROM projection_binding_release pb
    JOIN template_candidates pc ON pc.id = pb.candidate_id
    WHERE EXISTS (SELECT 1 FROM (${source}) projection_apple_head
      WHERE projection_apple_head.id = pc.source_release_id)
  INTERSECT
  SELECT pb.id FROM projection_binding_release pb
    JOIN template_candidates pc ON pc.id = pb.candidate_id
    WHERE pc.provider = 'samsung' AND pc.adapter_revision = ${SAMSUNG_PROJECTION_POLICY.adapterRevision}
      AND pc.adapter_capabilities = '${samsung}' AND pc.audience_policy_revision = ${SAMSUNG_PROJECTION_POLICY.audiencePolicyRevision}
      AND (${samsungProjectionEvidencePredicateSql('pc', nowSql, scope.credentialKeysetCommitmentSql)}))`;
}

/** Reads the effective scoped Apple head without accepting it as native approval. */
export async function effectiveAppleSourceId(
  db: D1Database,
  scope: { templateId: string; orgId: string; mode: Mode },
): Promise<string | null> {
  const sql = activeReleaseIdSql({
    templateIdSql: 'requested.template_id',
    orgIdSql: 'requested.org_id',
    modeSql: 'requested.mode',
    providerSql: "'apple'",
  });
  const row = await first<{ id: string | null }>(
    db,
    `SELECT (${sql}) AS id FROM (SELECT ? AS template_id, ? AS org_id, ? AS mode) requested`,
    [scope.templateId, scope.orgId, scope.mode],
  );
  return row?.id ?? null;
}

/** Repeat the provider/source/account fence after cryptographic content validation. */
export async function projectionReleaseBindingValid(
  db: D1Database,
  scope: {
    releaseId: string;
    orgId: string;
    mode: Mode;
    provider: NativeProvider;
    templateId: string;
    version: string;
    sourceReleaseId: string;
    now: number;
    credentialKeysetCommitment: string;
  },
): Promise<boolean> {
  if (
    typeof scope.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(scope.credentialKeysetCommitment)
  )
    return false;
  const predicate = projectionReleaseBindingPredicateSql({
    releaseIdSql: 'requested.release_id',
    orgIdSql: 'requested.org_id',
    modeSql: 'requested.mode',
    providerSql: 'requested.provider',
    templateIdSql: 'requested.template_id',
    versionSql: 'requested.version',
    sourceReleaseIdSql: 'requested.source_id',
    nowSql: 'requested.now_ms',
    credentialKeysetCommitmentSql: 'requested.credential_keyset_commitment',
  });
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM
    (SELECT ? AS release_id, ? AS org_id, ? AS mode, ? AS provider, ? AS template_id, ? AS version,
      ? AS source_id, ? AS now_ms, ? AS credential_keyset_commitment) requested
    WHERE ${predicate}`,
    [
      scope.releaseId,
      scope.orgId,
      scope.mode,
      scope.provider,
      scope.templateId,
      scope.version,
      scope.sourceReleaseId,
      scope.now,
      scope.credentialKeysetCommitment,
    ],
  );
  return row !== null;
}

export interface ProjectionRetirementMetadata extends WalletCredentialKeysetProof {
  id: string;
  generation: number;
  orgId: string;
  mode: Mode;
  provider: NativeProvider;
  templateId: string;
  version: string;
  sourceReleaseId: string;
  accountId: string;
  accountRevision: number;
  providerIdentityHash: string;
  adapterRevision: number;
  policyRevision: number;
  projection: NativeProjection;
}

/** Historical metadata only, never authority to issue or update a wallet object. */
export async function getProjectionRetirementMetadata(
  db: D1Database,
  releaseId: string,
  proof: WalletCredentialKeysetProof,
): Promise<ProjectionRetirementMetadata | null> {
  const credentialKeysetCommitment = proof?.credentialKeysetCommitment;
  if (
    typeof credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(credentialKeysetCommitment)
  )
    return null;
  const row = await first<
    Omit<ProjectionRetirementMetadata, 'projection'> & {
      candidateId: string;
      candidateHash: string;
    }
  >(
    db,
    `SELECT r.id, r.generation, r.org_id AS orgId, r.mode, r.provider, r.template_id AS templateId,
      r.version, c.id AS candidateId, c.candidate_hash AS candidateHash,
      c.source_release_id AS sourceReleaseId, c.provider_account_id AS accountId,
      c.provider_account_revision AS accountRevision, c.provider_identity_hash AS providerIdentityHash,
      c.adapter_revision AS adapterRevision, c.audience_policy_revision AS policyRevision,
      r.credential_keyset_commitment AS credentialKeysetCommitment
      FROM template_releases r JOIN template_candidates c ON c.id = r.candidate_id
        AND c.org_id = r.org_id AND c.mode = r.mode AND c.provider = r.provider
        AND c.template_id = r.template_id AND c.version = r.version AND c.content_hash = r.content_hash
        AND c.adapter_revision = r.adapter_revision AND c.adapter_capabilities = r.adapter_capabilities
        AND c.audience_policy_revision = r.audience_policy_revision
      JOIN template_approvals a ON a.id = r.approval_id AND a.candidate_id = c.id
      WHERE r.id = ? AND r.source = 'approved' AND r.provider IN ('google','samsung')
        AND r.candidate_hash = c.candidate_hash AND a.candidate_hash = c.candidate_hash
        AND r.credential_keyset_commitment = ? AND c.credential_keyset_commitment = r.credential_keyset_commitment
        AND a.credential_keyset_commitment = r.credential_keyset_commitment AND ${credentialRefKeysetSql}
        AND a.reviewer_id != c.author_id AND (c.version_author_id IS NULL OR a.reviewer_id != c.version_author_id)`,
    [releaseId, credentialKeysetCommitment, credentialKeysetCommitment],
  );
  if (!row) return null;
  const candidate = await getProjectionCandidate(db, row.candidateId);
  if (
    !candidate ||
    candidate.credentialKeysetCommitment !== credentialKeysetCommitment ||
    (await candidateHash(projectionCandidateEnvelope(candidate))) !== row.candidateHash
  )
    return null;
  if (!(await first(db, `SELECT 1 WHERE ${credentialRefKeysetSql}`, [credentialKeysetCommitment])))
    return null;
  const { candidateId: _candidateId, candidateHash: _candidateHash, ...metadata } = row;
  return { ...metadata, projection: candidate.projection };
}

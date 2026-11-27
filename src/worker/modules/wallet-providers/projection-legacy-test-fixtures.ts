import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import { hasCredentialSql } from './account-presence.ts';
import { GOOGLE_PROJECTION_POLICY, SAMSUNG_PROJECTION_POLICY } from './projection-contract.ts';
import { approvalStandsSql } from './projection-system-authority.ts';
import {
  type ProjectionReleaseScopeSql,
  projectionReleaseBindingPredicateSql,
} from './repo-projection.ts';

/** Test fixture: the projection fence as it read before its CTE was replaced by direct reads. */
export function legacyProjectionReleaseBindingPredicateSql(
  scope: ProjectionReleaseScopeSql,
): string {
  if (!scope.nowSql || !scope.credentialKeysetCommitmentSql)
    throw new Error('A trusted projection evidence clock and credential keyset are required.');
  // The caller's clock stays bound in this predicate: its statements pass the value in this position.
  const nowSql = scope.nowSql;
  const samsung = JSON.stringify(SAMSUNG_PROJECTION_POLICY.adapterCapabilities).replaceAll(
    "'",
    "''",
  );
  const google = JSON.stringify(GOOGLE_PROJECTION_POLICY.adapterCapabilities).replaceAll("'", "''");
  const source = effectiveReleaseIdSql({
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
      AND paccount.authority_epoch = pc.provider_account_epoch AND ${hasCredentialSql('paccount')}
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
      AND (pv.created_by IS pc.version_author_id AND ${approvalStandsSql('pa', 'pc')}
        AND pr.created_by IS NOT NULL
        AND pc.projection_json IS NOT NULL AND json_valid(pc.projection_json)
        AND json_type(pc.projection_json) = 'object' AND length(pc.provider_identity_hash) = 64)
      AND EXISTS (SELECT 1 FROM template_release_heads head WHERE head.release_id = pr.id)
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
    WHERE (pc.provider = 'google' AND json_extract(pc.projection_json, '$.schema') = 2
        AND pc.adapter_revision = ${GOOGLE_PROJECTION_POLICY.adapterRevision}
        AND pc.adapter_capabilities = '${google}'
        AND pc.audience_policy_revision = ${GOOGLE_PROJECTION_POLICY.audiencePolicyRevision})
      OR (pc.provider = 'samsung' AND json_extract(pc.projection_json, '$.schema') = 2
        AND pc.adapter_revision = ${SAMSUNG_PROJECTION_POLICY.adapterRevision}
        AND pc.adapter_capabilities = '${samsung}' AND pc.audience_policy_revision = ${SAMSUNG_PROJECTION_POLICY.audiencePolicyRevision}
        AND (${nowSql}) IS NOT NULL))`;
}

/** The instance proof with its embedded projection fence swapped for the legacy form. */
export function withLegacyProjection(proofSql: string, nowSql: string): string {
  const scope = {
    releaseIdSql: 'op.projection_release_id',
    orgIdSql: 'i.org_id',
    modeSql: 'i.mode',
    providerSql: 'i.provider',
    templateIdSql: 'p.template_id',
    versionSql: 'p.template_version',
    sourceReleaseIdSql: 'p.release_id',
    nowSql,
    credentialKeysetCommitmentSql: 'op.credential_keyset_commitment',
  };
  const current = projectionReleaseBindingPredicateSql(scope);
  if (!proofSql.includes(current))
    throw new Error('The proof does not embed the projection fence.');
  return proofSql.replace(current, () => legacyProjectionReleaseBindingPredicateSql(scope));
}

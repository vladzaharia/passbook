import type { Mode } from '../../../shared/contracts/common.ts';
import { batch, stmt } from '../../platform/db.ts';
import { samsungOperationKeysetSql } from './repo-callbacks.ts';

export interface SamsungRetirementScope {
  orgId: string;
  mode: Mode;
  instanceId: string;
  operationVersion: number;
  credentialKeysetCommitment: string;
}

const retirementJoins = `FROM wallet_provider_instances i
  JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
    AND op.instance_id = i.id AND op.version = i.desired_version
  JOIN passes p ON p.id = i.pass_id AND p.org_id = i.org_id AND p.mode = i.mode
    AND p.version = op.pass_version AND p.revision = op.pass_revision
    AND p.lifecycle_generation = op.lifecycle_generation AND p.release_id IS op.issuing_release_id
    AND p.credential_generation = op.pass_credential_generation
    AND i.credential_generation <= p.credential_generation
  JOIN wallet_provider_accounts account ON account.id = i.account_id
    AND account.org_id = i.org_id AND account.mode = i.mode AND account.provider = 'samsung'
  JOIN template_releases original ON original.id = i.identity_projection_release_id
    AND original.id = op.projection_release_id AND original.org_id = i.org_id
    AND original.mode = i.mode AND original.provider = 'samsung' AND original.template_id = p.template_id
    AND original.source = 'approved' AND original.credential_keyset_commitment = i.credential_keyset_commitment
  JOIN template_candidates candidate ON candidate.id = original.candidate_id
    AND candidate.provider_account_id = i.account_id AND candidate.candidate_hash = original.candidate_hash
    AND candidate.org_id = i.org_id AND candidate.mode = i.mode AND candidate.provider = 'samsung'
    AND candidate.credential_keyset_commitment = i.credential_keyset_commitment
  JOIN wallet_provider_account_events approved ON approved.account_id = account.id
    AND approved.org_id = i.org_id AND approved.mode = i.mode AND approved.provider = 'samsung'
    AND approved.revision = candidate.provider_account_revision AND approved.kind = 'configure'
  JOIN wallet_provider_credentials secret ON secret.id = approved.credential_id
    AND secret.account_id = account.id AND secret.org_id = i.org_id
    AND secret.mode = i.mode AND secret.provider = 'samsung'
  JOIN template_approvals approval ON approval.id = original.approval_id
    AND approval.candidate_id = candidate.id AND approval.candidate_hash = candidate.candidate_hash
    AND approval.credential_keyset_commitment = i.credential_keyset_commitment
    AND approval.reviewer_id != candidate.author_id
    AND (candidate.version_author_id IS NULL OR approval.reviewer_id != candidate.version_author_id)`;
// Materialize the current authority and the historical proof separately. Joining all
// of their predicates to an INSERT makes D1 exceed its expression-depth limit.
const retirementCtes = `WITH retirement_base AS MATERIALIZED (
  SELECT i.id AS instance_id, i.org_id, i.mode, i.account_id, i.credential_keyset_commitment,
    i.retirement_requested_at, p.template_id, candidate.id AS candidate_id,
    candidate.provider_account_revision AS account_revision, candidate.provider_identity_hash,
    original.id AS release_id
  ${retirementJoins}
  WHERE i.id = ? AND i.org_id = ? AND i.mode = ? AND i.provider = 'samsung'
    AND op.version = ? AND op.kind = 'revoke' AND op.state = 'succeeded'
    AND i.lifecycle IN ('revoked', 'retired') AND candidate.provider_identity_hash = ?
    AND EXISTS (SELECT 1 FROM wallet_provider_projection_evidence_history evidence
      WHERE evidence.candidate_id = candidate.id AND evidence.org_id = i.org_id AND evidence.mode = i.mode
        AND evidence.account_id = i.account_id AND evidence.account_revision = candidate.provider_account_revision
        AND evidence.provider_identity_hash = candidate.provider_identity_hash
        AND evidence.candidate_hash = candidate.candidate_hash
        AND evidence.credential_keyset_commitment = i.credential_keyset_commitment
        AND evidence.card_type = json_extract(candidate.projection_json, '$.cardType')
        AND evidence.card_sub_type = json_extract(candidate.projection_json, '$.cardSubType')
        AND evidence.country_code = json_extract(candidate.projection_json, '$.countryCode')
        AND evidence.testing_mode_off = 'Y'
        AND evidence.verified_at <= original.created_at AND original.created_at < evidence.expires_at)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
      WHERE busy.instance_id = i.id AND busy.state IN ('claimed', 'uncertain'))
    AND ${samsungOperationKeysetSql}
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs stored_ref
      WHERE stored_ref.instance_id = i.id
        AND stored_ref.credential_keyset_commitment IS NOT i.credential_keyset_commitment)
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs stored_ref
      JOIN wallet_samsung_tombstones existing_tomb ON existing_tomb.ref_hash = stored_ref.ref_hash
      WHERE stored_ref.instance_id = i.id
        AND existing_tomb.credential_keyset_commitment IS NOT i.credential_keyset_commitment)
), invalid_historical AS MATERIALIZED (
  SELECT base.instance_id
  FROM retirement_base base
  JOIN wallet_provider_instance_operations historical ON historical.instance_id = base.instance_id
    AND historical.kind = 'upsert' AND historical.state = 'succeeded'
  WHERE historical.credential_keyset_commitment IS NOT base.credential_keyset_commitment
    OR NOT EXISTS (SELECT 1 FROM template_releases historical_release
      JOIN template_candidates historical_candidate ON historical_candidate.id = historical_release.candidate_id
      JOIN template_approvals historical_approval ON historical_approval.id = historical_release.approval_id
        AND historical_approval.candidate_id = historical_candidate.id
      WHERE historical_release.id = historical.projection_release_id
        AND historical_release.org_id = base.org_id AND historical_release.mode = base.mode
        AND historical_release.provider = 'samsung' AND historical_release.source = 'approved'
        AND historical_release.template_id = base.template_id
        AND historical_release.credential_keyset_commitment = base.credential_keyset_commitment
        AND historical_release.adapter_revision = historical.adapter_revision
        AND historical_release.audience_policy_revision = historical.policy_revision
        AND historical_candidate.org_id = base.org_id AND historical_candidate.mode = base.mode
        AND historical_candidate.provider = 'samsung' AND historical_candidate.provider_account_id = base.account_id
        AND historical_candidate.provider_account_revision = historical.account_revision
        AND historical_candidate.provider_identity_hash = base.provider_identity_hash
        AND historical_candidate.candidate_hash = historical_release.candidate_hash
        AND historical_candidate.content_hash = historical_release.content_hash
        AND historical_candidate.adapter_revision = historical_release.adapter_revision
        AND historical_candidate.audience_policy_revision = historical_release.audience_policy_revision
        AND historical_candidate.credential_keyset_commitment = base.credential_keyset_commitment
        AND historical_approval.candidate_hash = historical_candidate.candidate_hash
        AND historical_approval.credential_keyset_commitment = base.credential_keyset_commitment
        AND historical_approval.reviewer_id != historical_candidate.author_id
        AND (historical_candidate.version_author_id IS NULL
          OR historical_approval.reviewer_id != historical_candidate.version_author_id)
        AND EXISTS (SELECT 1 FROM wallet_provider_account_events historical_config
          JOIN wallet_provider_credentials historical_credential
            ON historical_credential.id = historical_config.credential_id
            AND historical_credential.account_id = base.account_id
            AND historical_credential.org_id = base.org_id AND historical_credential.mode = base.mode
            AND historical_credential.provider = 'samsung'
          WHERE historical_config.account_id = base.account_id
            AND historical_config.org_id = base.org_id AND historical_config.mode = base.mode
            AND historical_config.provider = 'samsung' AND historical_config.kind = 'configure'
            AND historical_config.revision = historical.account_revision)
        AND EXISTS (SELECT 1 FROM wallet_provider_projection_evidence_history historical_evidence
          WHERE historical_evidence.candidate_id = historical_candidate.id
            AND historical_evidence.org_id = base.org_id AND historical_evidence.mode = base.mode
            AND historical_evidence.account_id = base.account_id
            AND historical_evidence.account_revision = historical.account_revision
            AND historical_evidence.credential_keyset_commitment = base.credential_keyset_commitment
            AND historical_evidence.provider_identity_hash = historical_candidate.provider_identity_hash
            AND historical_evidence.candidate_hash = historical_candidate.candidate_hash
            AND historical_evidence.card_type = json_extract(historical_candidate.projection_json, '$.cardType')
            AND historical_evidence.card_sub_type = json_extract(historical_candidate.projection_json, '$.cardSubType')
            AND historical_evidence.country_code = json_extract(historical_candidate.projection_json, '$.countryCode')
            AND historical_evidence.testing_mode_off = 'Y'
            AND historical_evidence.verified_at <= historical_release.created_at
            AND historical_release.created_at < historical_evidence.expires_at))
), retirement_scope AS MATERIALIZED (
  SELECT base.* FROM retirement_base base
  WHERE NOT EXISTS (SELECT 1 FROM invalid_historical historical
    WHERE historical.instance_id = base.instance_id)
)`;
const allReferencesTombstoned = `NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref
  WHERE ref.instance_id = retirement.instance_id AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones tomb
    WHERE tomb.ref_hash = ref.ref_hash AND tomb.org_id = retirement.org_id AND tomb.mode = retirement.mode
      AND tomb.account_id = retirement.account_id AND tomb.candidate_id = retirement.candidate_id
      AND tomb.release_id = retirement.release_id
      AND ((ref.retired_at IS NOT NULL AND ref.promoted_at IS NULL)
        OR tomb.account_revision = retirement.account_revision)
      AND tomb.provider_identity_hash = retirement.provider_identity_hash
      AND tomb.credential_keyset_commitment = retirement.credential_keyset_commitment))`;

/** Publish a historical public-verifier binding after provider acceptance, before pass deletion. */
export async function putSamsungTombstone(
  db: D1Database,
  scope: SamsungRetirementScope,
  identityHash: string,
  now: number,
): Promise<boolean> {
  const values = [
    scope.instanceId,
    scope.orgId,
    scope.mode,
    scope.operationVersion,
    identityHash,
    scope.credentialKeysetCommitment,
    scope.credentialKeysetCommitment,
  ] as const;
  const results = await batch(db, [
    stmt(
      db,
      `${retirementCtes}
      INSERT INTO wallet_samsung_tombstones
      (ref_hash, org_id, mode, account_id, account_revision, candidate_id, release_id,
       provider_identity_hash, retired_at, credential_keyset_commitment)
      SELECT ref.ref_hash, retirement.org_id, retirement.mode, retirement.account_id,
        retirement.account_revision, retirement.candidate_id, retirement.release_id,
        retirement.provider_identity_hash, ?, retirement.credential_keyset_commitment
      FROM retirement_scope retirement
      JOIN wallet_samsung_fetch_refs ref ON ref.instance_id = retirement.instance_id
      WHERE (ref.retired_at IS NULL OR ref.promoted_at IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM wallet_samsung_tombstones old WHERE old.ref_hash = ref.ref_hash
          AND old.org_id = retirement.org_id AND old.mode = retirement.mode
          AND old.account_id = retirement.account_id AND old.candidate_id = retirement.candidate_id
          AND old.release_id = retirement.release_id))
      ON CONFLICT(ref_hash, account_revision) DO NOTHING`,
      [...values, now],
    ),
    stmt(
      db,
      `${retirementCtes},
      historical_publications AS MATERIALIZED (
        SELECT ref.ref_hash, retirement.org_id, retirement.mode, retirement.account_id,
          historical.account_revision, historical_candidate.id AS candidate_id,
          historical_release.id AS release_id, historical_candidate.provider_identity_hash,
          retirement.credential_keyset_commitment
        FROM retirement_scope retirement
        JOIN wallet_samsung_fetch_refs ref
          ON ref.instance_id = retirement.instance_id AND ref.promoted_at IS NOT NULL
        JOIN wallet_provider_instance_operations historical ON historical.instance_id = retirement.instance_id
          AND historical.kind = 'upsert' AND historical.state = 'succeeded'
          AND historical.credential_keyset_commitment = retirement.credential_keyset_commitment
        JOIN template_releases historical_release ON historical_release.id = historical.projection_release_id
          AND historical_release.org_id = retirement.org_id AND historical_release.mode = retirement.mode
          AND historical_release.provider = 'samsung' AND historical_release.source = 'approved'
          AND historical_release.template_id = retirement.template_id
          AND historical_release.credential_keyset_commitment = retirement.credential_keyset_commitment
        JOIN template_candidates historical_candidate ON historical_candidate.id = historical_release.candidate_id
          AND historical_candidate.org_id = retirement.org_id AND historical_candidate.mode = retirement.mode
          AND historical_candidate.provider = 'samsung'
          AND historical_candidate.provider_account_id = retirement.account_id
          AND historical_candidate.provider_account_revision = historical.account_revision
          AND historical_candidate.credential_keyset_commitment = retirement.credential_keyset_commitment
          AND historical_candidate.provider_identity_hash = retirement.provider_identity_hash
          AND historical_candidate.candidate_hash = historical_release.candidate_hash
          AND historical_candidate.content_hash = historical_release.content_hash
          AND historical_candidate.adapter_revision = historical_release.adapter_revision
          AND historical_candidate.audience_policy_revision = historical_release.audience_policy_revision
          AND historical_release.adapter_revision = historical.adapter_revision
          AND historical_release.audience_policy_revision = historical.policy_revision
        JOIN template_approvals historical_approval ON historical_approval.id = historical_release.approval_id
          AND historical_approval.candidate_id = historical_candidate.id
          AND historical_approval.candidate_hash = historical_candidate.candidate_hash
          AND historical_approval.credential_keyset_commitment = retirement.credential_keyset_commitment
          AND historical_approval.reviewer_id != historical_candidate.author_id
          AND (historical_candidate.version_author_id IS NULL
            OR historical_approval.reviewer_id != historical_candidate.version_author_id)
        JOIN wallet_provider_account_events historical_config ON historical_config.account_id = retirement.account_id
          AND historical_config.org_id = retirement.org_id AND historical_config.mode = retirement.mode
          AND historical_config.provider = 'samsung' AND historical_config.kind = 'configure'
          AND historical_config.revision = historical.account_revision
        JOIN wallet_provider_credentials historical_credential
          ON historical_credential.id = historical_config.credential_id
          AND historical_credential.account_id = retirement.account_id
          AND historical_credential.org_id = retirement.org_id
          AND historical_credential.mode = retirement.mode AND historical_credential.provider = 'samsung'
        JOIN wallet_provider_projection_evidence_history history ON history.candidate_id = historical_candidate.id
          AND history.org_id = retirement.org_id AND history.mode = retirement.mode
          AND history.account_id = retirement.account_id AND history.account_revision = historical.account_revision
          AND history.provider_identity_hash = historical_candidate.provider_identity_hash
          AND history.candidate_hash = historical_candidate.candidate_hash
          AND history.credential_keyset_commitment = retirement.credential_keyset_commitment
          AND history.card_type = json_extract(historical_candidate.projection_json, '$.cardType')
          AND history.card_sub_type = json_extract(historical_candidate.projection_json, '$.cardSubType')
          AND history.country_code = json_extract(historical_candidate.projection_json, '$.countryCode')
          AND history.testing_mode_off = 'Y' AND history.verified_at <= historical_release.created_at
          AND historical_release.created_at < history.expires_at
      )
      INSERT INTO wallet_samsung_tombstones
      (ref_hash, org_id, mode, account_id, account_revision, candidate_id, release_id,
       provider_identity_hash, retired_at, credential_keyset_commitment)
      SELECT ref_hash, org_id, mode, account_id, account_revision, candidate_id, release_id,
        provider_identity_hash, ?, credential_keyset_commitment
      FROM historical_publications WHERE 1
      ON CONFLICT(ref_hash, account_revision) DO NOTHING`,
      [...values, now],
    ),
    // Permanent transfer/purge retirement reserves the old reference exclusively for its
    // tombstone. A same-holder void/restore may keep its existing promoted reference.
    stmt(
      db,
      `${retirementCtes}
      UPDATE wallet_samsung_fetch_refs AS ref SET retired_at = ?
      WHERE ref.instance_id = ? AND ref.retired_at IS NULL AND EXISTS (
        SELECT 1 FROM retirement_scope retirement WHERE retirement.retirement_requested_at IS NOT NULL
          AND ${allReferencesTombstoned})`,
      [...values, now, scope.instanceId],
    ),
    stmt(
      db,
      `${retirementCtes}
      SELECT 1 AS ok FROM retirement_scope retirement WHERE ${allReferencesTombstoned}`,
      values,
    ),
  ]);
  return results[3]?.results.length === 1;
}

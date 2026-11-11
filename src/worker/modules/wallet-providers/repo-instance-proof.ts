import { projectionReleaseBindingPredicateSql } from './repo-projection.ts';

function alias(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) throw new Error('Invalid trusted SQL alias');
  return value;
}

/**
 * The aliases and nowSql are trusted SQL expressions. A revoke-only proof omits the
 * impossible upsert branch while retaining the common and complete revoke fences.
 */
export function walletInstanceProofSql(
  instanceAlias: string,
  operationAlias: string,
  nowSql: string,
  allowRestore = false,
  requiredKind?: 'revoke',
): string {
  const i = alias(instanceAlias);
  const op = alias(operationAlias);
  const projection =
    requiredKind === 'revoke'
      ? ''
      : projectionReleaseBindingPredicateSql({
          releaseIdSql: `${op}.projection_release_id`,
          orgIdSql: `${i}.org_id`,
          modeSql: `${i}.mode`,
          providerSql: `${i}.provider`,
          templateIdSql: 'p.template_id',
          versionSql: 'p.template_version',
          sourceReleaseIdSql: 'p.release_id',
          nowSql,
          credentialKeysetCommitmentSql: `${op}.credential_keyset_commitment`,
        });
  // The generation-fence view retains the settled retirement, keyset and tombstone checks.
  // Separate the correlated proofs to bound D1 depth within the caller's statement snapshot.
  return `((${op}.credential_keyset_commitment = ${i}.credential_keyset_commitment
    AND EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
      AND keyset.commitment = ${op}.credential_keyset_commitment))
    AND EXISTS (WITH pass_scope AS (
      SELECT p.id, p.template_id, p.template_version, p.release_id, p.credential_generation,
        p.status, p.deleted_at, p.removed_at, p.test_data_quarantined,
        owner.status AS owner_status, owner.branding AS owner_branding${
          requiredKind === 'revoke'
            ? ''
            : `,
        NOT EXISTS (SELECT 1 FROM previous_retirement WHERE NOT settled) AS previous_settled`
        }
      FROM passes p
      JOIN orgs owner ON owner.id = p.org_id
      JOIN wallet_provider_accounts account ON account.id = ${i}.account_id
        AND account.org_id = ${i}.org_id AND account.mode = ${i}.mode AND account.provider = ${i}.provider
        AND account.revision = ${op}.account_revision AND account.credential_id IS NOT NULL
        AND account.revoked_at IS NULL
      WHERE ((p.id = ${i}.pass_id AND p.org_id = ${i}.org_id AND p.mode = ${i}.mode)
        AND (p.version = ${op}.pass_version AND p.revision = ${op}.pass_revision
          AND p.lifecycle_generation = ${op}.lifecycle_generation AND p.release_id IS ${op}.issuing_release_id
          AND p.credential_generation = ${op}.pass_credential_generation))
    )${
      requiredKind === 'revoke'
        ? ''
        : `,
    previous_retirement AS (
      SELECT EXISTS (WITH completed_retirement AS (
        SELECT id FROM wallet_provider_retirement_complete WHERE id = previous.id
      ) SELECT 1 FROM completed_retirement) AS settled
      FROM wallet_provider_instances previous
      WHERE previous.pass_id = ${i}.pass_id AND previous.credential_generation < ${i}.credential_generation
    )`
    },
    instance_check AS MATERIALIZED (
      SELECT 1 FROM pass_scope p
      WHERE (${
        requiredKind === 'revoke'
          ? ''
          : `((((${op}.kind = 'upsert' AND ${i}.retirement_requested_at IS NULL
            AND ${i}.credential_generation = p.credential_generation)
          AND (NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
            WHERE transfer.pass_id = p.id AND transfer.state = 'pending')
            AND p.previous_settled
            AND ${i}.lifecycle ${allowRestore ? "IN ('active', 'revoking', 'revoked')" : "= 'active'"}))
          AND ((p.owner_status = 'active' AND p.status = 'active' AND p.deleted_at IS NULL AND p.removed_at IS NULL
            AND p.test_data_quarantined = 0) AND ${projection}))
          AND ((COALESCE(json_type(p.owner_branding, '$.icon'), 'null') = 'null'
              AND COALESCE(json_type(p.owner_branding, '$.logo'), 'null') = 'null')
            AND (NOT EXISTS (SELECT 1 FROM pass_assets asset WHERE asset.pass_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM member_photos photo
                WHERE photo.pass_id = p.id AND photo.include_in_pass = 1))
            AND EXISTS (SELECT 1 FROM template_releases exact_projection
              JOIN template_candidates exact_candidate ON exact_candidate.id = exact_projection.candidate_id
              WHERE (exact_projection.id = ${op}.projection_release_id
                AND exact_projection.adapter_revision = ${op}.adapter_revision
                AND exact_projection.audience_policy_revision = ${op}.policy_revision)
                AND ((exact_candidate.provider_account_id = ${i}.account_id
                  AND exact_candidate.provider_account_revision = ${op}.account_revision)
                  AND EXISTS (SELECT 1 FROM template_releases original_identity
                    JOIN template_candidates initial_candidate ON initial_candidate.id = original_identity.candidate_id
                    JOIN template_approvals initial_approval ON initial_approval.id = original_identity.approval_id
                      AND initial_approval.candidate_id = initial_candidate.id
                    WHERE (original_identity.id = ${i}.identity_projection_release_id
                      AND original_identity.org_id = ${i}.org_id AND original_identity.mode = ${i}.mode
                      AND original_identity.provider = ${i}.provider)
                      AND (initial_candidate.provider_account_id = ${i}.account_id
                        AND original_identity.credential_keyset_commitment = ${op}.credential_keyset_commitment
                        AND initial_candidate.credential_keyset_commitment = ${op}.credential_keyset_commitment
                        AND initial_approval.credential_keyset_commitment = ${op}.credential_keyset_commitment
                        AND initial_candidate.provider_identity_hash = exact_candidate.provider_identity_hash)))))) OR `
      }((${op}.kind = 'revoke' AND ${i}.lifecycle IN ('active', 'revoking')
          AND ${i}.credential_generation <= p.credential_generation
          AND ${op}.projection_release_id = ${i}.identity_projection_release_id)
        AND EXISTS (SELECT 1 FROM template_releases original
          JOIN template_candidates candidate ON candidate.id = original.candidate_id
          JOIN template_approvals approval ON approval.id = original.approval_id
            AND approval.candidate_id = candidate.id
          WHERE ((original.id = ${i}.identity_projection_release_id
            AND original.org_id = ${i}.org_id AND original.mode = ${i}.mode
            AND original.provider = ${i}.provider AND original.template_id = p.template_id
            AND original.source = 'approved')
            AND (candidate.provider_account_id = ${i}.account_id
              AND original.candidate_hash = candidate.candidate_hash
              AND approval.candidate_hash = candidate.candidate_hash
              AND original.credential_keyset_commitment = ${op}.credential_keyset_commitment
              AND candidate.credential_keyset_commitment = ${op}.credential_keyset_commitment
              AND approval.credential_keyset_commitment = ${op}.credential_keyset_commitment))
            AND ((${i}.provider != 'samsung' OR EXISTS (
              SELECT 1 FROM wallet_provider_projection_evidence_history evidence
              WHERE ((evidence.candidate_id = candidate.id AND evidence.org_id = ${i}.org_id
                  AND evidence.mode = ${i}.mode AND evidence.account_id = ${i}.account_id)
                AND (evidence.account_revision = candidate.provider_account_revision
                  AND evidence.provider_identity_hash = candidate.provider_identity_hash
                  AND evidence.candidate_hash = candidate.candidate_hash
                  AND evidence.credential_keyset_commitment = ${op}.credential_keyset_commitment))
                AND ((evidence.card_type = json_extract(candidate.projection_json, '$.cardType')
                  AND evidence.card_sub_type = json_extract(candidate.projection_json, '$.cardSubType')
                  AND evidence.country_code = json_extract(candidate.projection_json, '$.countryCode'))
                AND (evidence.testing_mode_off = 'Y' AND evidence.verified_at <= original.created_at
                  AND original.created_at < evidence.expires_at))))
              AND (approval.reviewer_id != candidate.author_id
                AND (candidate.version_author_id IS NULL OR approval.reviewer_id != candidate.version_author_id)
                AND original.adapter_revision = ${op}.adapter_revision
                AND original.audience_policy_revision = ${op}.policy_revision)))))
    )
    SELECT 1 FROM instance_check))`;
}

/** Requires the exact latest desired operation as well as every live authority fence. */
export function walletInstanceOperationCurrentSql(
  instanceAlias: string,
  operationAlias: string,
  nowSql: string,
  requiredKind?: 'revoke',
): string {
  const i = alias(instanceAlias);
  const op = alias(operationAlias);
  return `((${op}.instance_id = ${i}.id AND ${op}.id = ${i}.desired_operation_id
    AND ${op}.version = ${i}.desired_version) AND ${walletInstanceProofSql(i, op, nowSql, false, requiredKind)})`;
}

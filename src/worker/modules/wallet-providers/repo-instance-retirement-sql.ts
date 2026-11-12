/** Trusted alias only. A placeholder has never acquired any external identity or response. */
export function walletNoProviderArtifactsSql(instanceAlias: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(instanceAlias)) throw new Error('Invalid trusted SQL alias');
  const i = instanceAlias;
  return `${i}.account_id IS NULL AND ${i}.identity_projection_release_id IS NULL
    AND ${i}.desired_operation_id IS NULL AND ${i}.desired_version = 0
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations unissued_op WHERE unissued_op.instance_id = ${i}.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_offer_refs unissued_offer WHERE unissued_offer.instance_id = ${i}.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs unissued_ref WHERE unissued_ref.instance_id = ${i}.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_bindings unissued_binding WHERE unissued_binding.instance_id = ${i}.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_callback_events unissued_event WHERE unissued_event.instance_id = ${i}.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_callback_receipts unissued_samsung WHERE unissued_samsung.instance_id = ${i}.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_receipts unissued_google WHERE unissued_google.instance_id = ${i}.id)`;
}

export function retirementProjectionSql(i: string): string {
  return `EXISTS (SELECT 1 FROM template_releases projection_release
    JOIN template_candidates candidate ON candidate.id = projection_release.candidate_id
    JOIN template_approvals approval ON approval.id = projection_release.approval_id AND approval.candidate_id = candidate.id
    WHERE projection_release.id = ${i}.identity_projection_release_id AND projection_release.org_id = ${i}.org_id
      AND projection_release.mode = ${i}.mode AND projection_release.provider = ${i}.provider AND projection_release.source = 'approved'
      AND candidate.org_id = ${i}.org_id AND candidate.mode = ${i}.mode AND candidate.provider = ${i}.provider
      AND candidate.provider_account_id = ${i}.account_id AND projection_release.candidate_hash = candidate.candidate_hash
      AND approval.candidate_hash = candidate.candidate_hash
      AND projection_release.credential_keyset_commitment = ${i}.credential_keyset_commitment
      AND candidate.credential_keyset_commitment = ${i}.credential_keyset_commitment
      AND approval.credential_keyset_commitment = ${i}.credential_keyset_commitment)`;
}

export function desiredOperationKeysetSql(i: string): string {
  return `EXISTS (SELECT 1 FROM wallet_provider_instance_operations desired
    WHERE desired.id = ${i}.desired_operation_id AND desired.instance_id = ${i}.id
      AND desired.version = ${i}.desired_version
      AND desired.credential_keyset_commitment = ${i}.credential_keyset_commitment)`;
}

/** The pinned Samsung identity must have had matching verification when it was released. */
export function samsungRetirementProjectionSql(i: string): string {
  // This proof is nested in transfer retirement checks; group it as in the matching D1 view.
  return `EXISTS (SELECT 1 FROM template_releases retirement_release
    JOIN template_candidates retirement_candidate ON retirement_candidate.id = retirement_release.candidate_id
    JOIN template_approvals retirement_approval ON retirement_approval.id = retirement_release.approval_id
      AND retirement_approval.candidate_id = retirement_candidate.id
    JOIN wallet_provider_projection_evidence_history retirement_evidence
      ON retirement_evidence.candidate_id = retirement_candidate.id
    WHERE (retirement_release.id = ${i}.identity_projection_release_id
      AND retirement_release.org_id = ${i}.org_id AND retirement_release.mode = ${i}.mode
      AND retirement_release.provider = 'samsung' AND retirement_release.source = 'approved'
      AND retirement_candidate.provider_account_id = ${i}.account_id
      AND retirement_candidate.org_id = ${i}.org_id AND retirement_candidate.mode = ${i}.mode
      AND retirement_candidate.provider = 'samsung')
      AND (retirement_release.candidate_hash = retirement_candidate.candidate_hash
      AND retirement_approval.candidate_hash = retirement_candidate.candidate_hash
      AND retirement_approval.reviewer_id != retirement_candidate.author_id
      AND (retirement_candidate.version_author_id IS NULL
        OR retirement_approval.reviewer_id != retirement_candidate.version_author_id)
      AND retirement_release.credential_keyset_commitment = ${i}.credential_keyset_commitment
      AND retirement_candidate.credential_keyset_commitment = ${i}.credential_keyset_commitment
      AND retirement_approval.credential_keyset_commitment = ${i}.credential_keyset_commitment
      AND retirement_evidence.credential_keyset_commitment = ${i}.credential_keyset_commitment)
      AND (retirement_evidence.org_id = ${i}.org_id AND retirement_evidence.mode = ${i}.mode
      AND retirement_evidence.account_id = ${i}.account_id
      AND retirement_evidence.account_revision = retirement_candidate.provider_account_revision
      AND retirement_evidence.candidate_hash = retirement_candidate.candidate_hash
      AND retirement_evidence.provider_identity_hash = retirement_candidate.provider_identity_hash
      AND retirement_evidence.card_type = json_extract(retirement_candidate.projection_json, '$.cardType')
      AND retirement_evidence.card_sub_type = json_extract(retirement_candidate.projection_json, '$.cardSubType')
      AND retirement_evidence.country_code = json_extract(retirement_candidate.projection_json, '$.countryCode')
      AND retirement_evidence.testing_mode_off = 'Y'
      AND retirement_evidence.verified_at <= retirement_release.created_at
      AND retirement_release.created_at < retirement_evidence.expires_at))`;
}

/** All aliases are trusted repository SQL identifiers. */
export function samsungTombstoneBindingSql(i: string, ref: string, tomb: string): string {
  return `${ref}.credential_keyset_commitment = ${i}.credential_keyset_commitment
    AND ${tomb}.credential_keyset_commitment = ${i}.credential_keyset_commitment
    AND ${tomb}.ref_hash = ${ref}.ref_hash AND ${tomb}.org_id = ${i}.org_id
    AND ${tomb}.mode = ${i}.mode AND ${tomb}.account_id = ${i}.account_id
    AND EXISTS (SELECT 1 FROM template_releases tomb_release
      JOIN template_candidates tomb_candidate ON tomb_candidate.id = tomb_release.candidate_id
      WHERE tomb_release.id = ${i}.identity_projection_release_id AND ${tomb}.release_id = tomb_release.id
        AND ${tomb}.candidate_id = tomb_candidate.id AND tomb_candidate.provider_account_id = ${i}.account_id
        AND tomb_release.credential_keyset_commitment = ${i}.credential_keyset_commitment
        AND tomb_candidate.credential_keyset_commitment = ${i}.credential_keyset_commitment
        AND ${tomb}.account_revision = tomb_candidate.provider_account_revision
        AND ${tomb}.provider_identity_hash = tomb_candidate.provider_identity_hash)`;
}

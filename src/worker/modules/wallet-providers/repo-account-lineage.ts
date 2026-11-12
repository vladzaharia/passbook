/** Historical provider identities cannot be adopted under a different or unproven keyset. */
export const accountCredentialLineageSql = `NOT EXISTS (
    SELECT 1 FROM wallet_provider_instances i WHERE i.account_id = a.id AND (
      i.credential_keyset_commitment IS NOT (SELECT commitment FROM credential_ref_keyset WHERE id = 1)
      OR EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.instance_id = i.id
        AND op.credential_keyset_commitment IS NOT i.credential_keyset_commitment)
      OR EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref WHERE ref.instance_id = i.id
        AND ref.credential_keyset_commitment IS NOT i.credential_keyset_commitment)
      OR EXISTS (SELECT 1 FROM wallet_google_callback_bindings b WHERE b.instance_id = i.id
        AND b.credential_keyset_commitment IS NOT i.credential_keyset_commitment)
    )
  ) AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones t WHERE t.account_id = a.id
    AND t.credential_keyset_commitment IS NOT (SELECT commitment FROM credential_ref_keyset WHERE id = 1))
  AND NOT EXISTS (SELECT 1 FROM template_candidates candidate WHERE candidate.provider_account_id = a.id AND (
    candidate.credential_keyset_commitment IS NOT (SELECT commitment FROM credential_ref_keyset WHERE id = 1)
    OR EXISTS (SELECT 1 FROM template_approvals approval WHERE approval.candidate_id = candidate.id
      AND approval.credential_keyset_commitment IS NOT candidate.credential_keyset_commitment)
    OR EXISTS (SELECT 1 FROM template_releases release WHERE release.candidate_id = candidate.id
      AND release.credential_keyset_commitment IS NOT candidate.credential_keyset_commitment)
    OR EXISTS (SELECT 1 FROM wallet_provider_projection_evidence evidence WHERE evidence.candidate_id = candidate.id
      AND evidence.credential_keyset_commitment IS NOT candidate.credential_keyset_commitment)
    OR EXISTS (SELECT 1 FROM wallet_provider_projection_evidence evidence
      JOIN wallet_provider_projection_evidence_history history ON history.id = evidence.probe_id
        AND history.candidate_id = evidence.candidate_id
      WHERE evidence.candidate_id = candidate.id
        AND history.credential_keyset_commitment IS NOT candidate.credential_keyset_commitment)
  ))`;

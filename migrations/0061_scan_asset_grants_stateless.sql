-- Asset grants are stateless HMACs: nothing is stored per grant. A grant binds the keyset commitment,
-- so a rotated keyset voids it and no stored row needs to block the keyset initializer.
DROP TRIGGER credential_ref_keyset_insert_guard;
CREATE TRIGGER credential_ref_keyset_insert_guard
BEFORE INSERT ON credential_ref_keyset
WHEN (
  EXISTS (SELECT 1 FROM credential_ref_keyset)
  OR EXISTS (SELECT 1 FROM pass_credential_tombstones)
  OR EXISTS (SELECT 1 FROM connection_webhook_retention)
  OR EXISTS (SELECT 1 FROM workflow_runs WHERE credential_keyset_commitment IS NOT NULL)
) OR (
  EXISTS (SELECT 1 FROM connection_webhook_items
    WHERE claim_snapshot IS NOT NULL)
  OR EXISTS (SELECT 1 FROM scan_retention_proofs)
  OR EXISTS (SELECT 1 FROM scan_retention_event_transitions WHERE pass_ref IS NOT NULL)
  OR EXISTS (SELECT 1 FROM scan_retention_delete_intents)
) OR (
  EXISTS (SELECT 1 FROM scan_retained_gates)
  OR EXISTS (SELECT 1 FROM credential_ref_keyset_blocking_events)
  -- Approvals retain their candidate by FK, so a native candidate also covers legacy reviews.
  OR EXISTS (SELECT 1 FROM template_candidates
    WHERE provider IN ('google', 'samsung') OR credential_keyset_commitment IS NOT NULL)
  OR EXISTS (SELECT 1 FROM template_approvals WHERE credential_keyset_commitment IS NOT NULL)
  OR EXISTS (SELECT 1 FROM template_releases
    WHERE provider IN ('google', 'samsung') OR credential_keyset_commitment IS NOT NULL)
) OR (
  EXISTS (SELECT 1 FROM wallet_provider_projection_evidence)
  OR EXISTS (SELECT 1 FROM wallet_provider_projection_evidence_history)
  OR EXISTS (SELECT 1 FROM wallet_provider_instances)
  OR EXISTS (SELECT 1 FROM wallet_provider_instance_operations)
  OR EXISTS (SELECT 1 FROM wallet_provider_offer_refs)
) OR (
  EXISTS (SELECT 1 FROM wallet_google_callback_bindings)
  OR EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs)
  OR EXISTS (SELECT 1 FROM wallet_samsung_tombstones)
  OR EXISTS (SELECT 1 FROM wallet_google_callback_replays)
  OR EXISTS (SELECT 1 FROM wallet_samsung_auth_replays)
)
BEGIN SELECT RAISE(ABORT, 'credential reference keyset cannot be initialized'); END;

DROP TABLE scan_asset_grant_provenance;

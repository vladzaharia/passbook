-- Passless refusals are read from their `scans` row; the proof table and the triggers that maintained it go.
DROP TRIGGER IF EXISTS scan_passless_scan_changed;
DROP TRIGGER IF EXISTS scan_passless_scan_reference;
DROP TRIGGER IF EXISTS scan_passless_event_insert;
DROP TRIGGER IF EXISTS scan_passless_event_update;
DROP TRIGGER IF EXISTS scan_passless_gate_insert;
DROP TRIGGER IF EXISTS scan_passless_gate_update;
DROP TRIGGER IF EXISTS scan_passless_presence_insert;
DROP TRIGGER IF EXISTS scan_passless_presence_update;
DROP TRIGGER IF EXISTS scan_passless_intent_insert;
DROP TRIGGER IF EXISTS scan_passless_retained_gate_insert;
DROP TRIGGER IF EXISTS scan_passless_insert_guard;
DROP TRIGGER IF EXISTS scan_passless_credential_keyset_guard;
DROP TRIGGER IF EXISTS scan_passless_immutable;
DROP TRIGGER IF EXISTS scan_passless_no_direct_delete;
DROP TABLE scan_passless_proofs;

-- The keyset initializer no longer checks the dropped table.
DROP TRIGGER credential_ref_keyset_insert_guard;
CREATE TRIGGER credential_ref_keyset_insert_guard
BEFORE INSERT ON credential_ref_keyset
WHEN (
  EXISTS (SELECT 1 FROM credential_ref_keyset)
  OR EXISTS (SELECT 1 FROM pass_credential_tombstones)
  OR EXISTS (SELECT 1 FROM scan_asset_grant_provenance)
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

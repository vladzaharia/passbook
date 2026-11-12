-- A verified holder attaches to a pass whose credential cannot change (a static barcode) without a
-- transfer: the owner goes from none to a user, and nothing else moves. Only the user the grant would
-- admit: active, with a verified address equal to the holder email, not blocked from the pass, which
-- is neither deleted nor quarantined. The owner removing the pass clears the owner after writing the
-- attach block for that user, which deletion of the user never does.
-- Any other owner, holder or credential change still needs a transfer.
DROP TRIGGER pass_credential_transfer_required;
CREATE TRIGGER pass_credential_transfer_required
BEFORE UPDATE OF holder_email, owner_user_id, serial, auth_token, scan_code, identity_id, org_id, mode ON passes
WHEN NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = OLD.id AND t.state = 'pending')
  AND (NEW.holder_email IS NOT OLD.holder_email
    OR (NEW.owner_user_id IS NOT OLD.owner_user_id
      AND NOT (OLD.owner_user_id IS NULL AND NEW.owner_user_id IS NOT NULL
        AND NEW.deleted_at IS NULL AND NEW.test_data_quarantined = 0
        AND EXISTS (SELECT 1 FROM users u JOIN user_emails e ON e.user_id = u.id
          WHERE u.id = NEW.owner_user_id AND u.status = 'active' AND e.email = NEW.holder_email)
        AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = OLD.id AND b.user_id = NEW.owner_user_id))
      AND NOT (OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NULL
        AND EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = OLD.id AND b.user_id = OLD.owner_user_id)))
    OR NEW.serial IS NOT OLD.serial OR NEW.auth_token IS NOT OLD.auth_token
    OR NEW.identity_id IS NOT OLD.identity_id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
    OR (OLD.scan_code IS NOT NULL AND NEW.scan_code IS NOT OLD.scan_code))
BEGIN SELECT RAISE(ABORT, 'credential transfer required'); END;

-- A connector transfer re-signs a pass under its own issued release when the template is archived or
-- the head is another build; only a release that is not the pass's own must still be an active head.
DROP TRIGGER pass_credential_transfer_insert_guard;
CREATE TRIGGER pass_credential_transfer_insert_guard
BEFORE INSERT ON pass_credential_transfers
WHEN NEW.state != 'pending' OR NEW.completed_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM pass_credential_transfers t
    WHERE t.id = NEW.id OR (t.pass_id = NEW.pass_id
      AND (t.state = 'pending' OR t.target_generation = NEW.target_generation)))
  OR NOT EXISTS (
    SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode
      AND p.test_data_quarantined = 0
      AND EXISTS (SELECT 1 FROM orgs org WHERE org.id = p.org_id AND org.status = 'active')
      AND p.credential_generation = NEW.source_generation AND p.row_version = NEW.source_row_version
      AND p.lifecycle_generation = NEW.source_lifecycle_generation
      AND p.link_generation + 1 = NEW.source_link_generation
  )
  OR (NEW.source_connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM passes p
    JOIN connections c ON c.id = p.connection_id AND c.org_id = p.org_id
    JOIN templates template ON template.id = p.template_id
    JOIN template_releases rel ON rel.id = NEW.source_admitted_release_id
    WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = 'live'
      AND p.connection_id = NEW.source_connection_id AND p.external_ref IS NEW.source_connection_ref
      AND c.enabled = 1 AND c.generation = NEW.source_connection_generation AND c.mode = NEW.source_connection_mode
      AND template.status != 'deleted'
      AND rel.template_id = p.template_id AND rel.mode = p.mode AND rel.provider = 'apple'
      AND rel.generation = NEW.source_admitted_release_generation
      AND rel.version = NEW.source_admitted_release_version
      AND (rel.org_id = p.org_id OR (rel.org_id IS NULL
        AND template.org_id IS NULL AND template.origin = 'baked'))
      AND (rel.id = p.release_id OR (template.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM template_releases newer WHERE newer.template_id = rel.template_id
          AND newer.org_id IS rel.org_id AND newer.mode = rel.mode AND newer.provider = rel.provider
          AND newer.generation > rel.generation)))
  ))
BEGIN SELECT RAISE(ABORT, 'invalid credential transfer snapshot'); END;

-- The finish accepts the pass's own admitted release the same way the start does.
DROP TRIGGER pass_credential_transfer_complete_guard;
CREATE TRIGGER pass_credential_transfer_complete_guard
BEFORE UPDATE ON pass_credential_transfers
WHEN OLD.state != 'pending' OR NEW.state != 'completed'
  OR OLD.id IS NOT NEW.id OR OLD.pass_id IS NOT NEW.pass_id OR OLD.org_id IS NOT NEW.org_id
  OR OLD.mode IS NOT NEW.mode OR OLD.source_generation IS NOT NEW.source_generation
  OR OLD.source_version IS NOT NEW.source_version OR OLD.source_revision IS NOT NEW.source_revision
  OR OLD.source_row_version IS NOT NEW.source_row_version
  OR OLD.source_lifecycle_generation IS NOT NEW.source_lifecycle_generation
  OR OLD.source_link_generation IS NOT NEW.source_link_generation
  OR OLD.source_connection_id IS NOT NEW.source_connection_id
  OR OLD.source_connection_ref IS NOT NEW.source_connection_ref
  OR OLD.source_connection_generation IS NOT NEW.source_connection_generation
  OR OLD.source_connection_mode IS NOT NEW.source_connection_mode
  OR OLD.source_admitted_release_id IS NOT NEW.source_admitted_release_id
  OR OLD.source_admitted_release_generation IS NOT NEW.source_admitted_release_generation
  OR OLD.source_admitted_release_version IS NOT NEW.source_admitted_release_version
  OR OLD.target_holder_email IS NOT NEW.target_holder_email
  OR OLD.target_owner_user_id IS NOT NEW.target_owner_user_id
  OR OLD.requested_by_type IS NOT NEW.requested_by_type OR OLD.requested_by_id IS NOT NEW.requested_by_id
  OR OLD.requested_at IS NOT NEW.requested_at
  OR NEW.completed_at IS NULL
  OR NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = OLD.pass_id AND p.org_id = OLD.org_id
    AND p.mode = OLD.mode AND p.credential_generation = OLD.target_generation
    AND p.row_version > OLD.source_row_version
    AND p.lifecycle_generation = OLD.source_lifecycle_generation
    AND p.link_generation = OLD.source_link_generation
    AND p.holder_email IS OLD.target_holder_email AND p.owner_user_id IS OLD.target_owner_user_id)
  -- A connector transfer finishes against whatever the connection and release head are now: a connection
  -- edit or a newer approved release moves neither the binding nor the head the finish rebuilt against.
  OR (OLD.source_connection_id IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM pass_credential_transfer_payloads payload WHERE payload.transfer_id = OLD.id)
    OR NOT EXISTS (
      SELECT 1 FROM passes p
      JOIN templates template ON template.id = p.template_id
      JOIN template_releases rel ON rel.id = p.release_id
      WHERE p.id = OLD.pass_id AND p.org_id = OLD.org_id AND p.mode = 'live'
        AND p.connection_id = OLD.source_connection_id AND p.external_ref IS OLD.source_connection_ref
        AND p.template_version = rel.version
        AND rel.template_id = p.template_id AND rel.mode = p.mode AND rel.provider = 'apple'
        AND (rel.org_id = p.org_id OR (rel.org_id IS NULL
          AND template.org_id IS NULL AND template.origin = 'baked'))
        AND ((template.status = 'active'
            AND EXISTS (SELECT 1 FROM template_release_heads head WHERE head.release_id = rel.id))
          OR (template.status != 'deleted' AND rel.id = OLD.source_admitted_release_id))
    )
  ))
  OR EXISTS (
    SELECT 1 FROM wallet_provider_instances i
    WHERE i.pass_id = OLD.pass_id AND i.credential_generation < OLD.target_generation
      AND (i.org_id IS NOT OLD.org_id OR i.mode IS NOT OLD.mode OR NOT (
        -- A retired placeholder has never acquired an external object or callback.
        (i.lifecycle = 'retired' AND i.retirement_reason = 'not_issued'
          AND i.account_id IS NULL AND i.identity_projection_release_id IS NULL
          AND i.desired_operation_id IS NULL AND i.desired_version = 0
          AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.instance_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM wallet_provider_offer_refs offer WHERE offer.instance_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref WHERE ref.instance_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_bindings binding WHERE binding.instance_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM wallet_provider_callback_events event WHERE event.instance_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM wallet_samsung_callback_receipts receipt WHERE receipt.instance_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_receipts receipt WHERE receipt.instance_id = i.id))
        OR
        -- An issued Samsung credential needs its accepted revoke and every fetch-ref tombstone.
        -- An issued Google credential cannot settle without an independent replay guarantee.
        (i.lifecycle = 'retired' AND i.provider = 'samsung' AND i.retirement_requested_at IS NOT NULL
          AND i.account_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM wallet_provider_accounts a WHERE a.id = i.account_id
            AND a.org_id = i.org_id AND a.mode = i.mode AND a.provider = i.provider)
          AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
            WHERE op.id = i.desired_operation_id AND op.instance_id = i.id
              AND op.version = i.desired_version AND op.kind = 'revoke' AND op.state = 'succeeded')
          AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
            WHERE busy.instance_id = i.id AND busy.state IN ('pending', 'retry', 'claimed', 'uncertain'))
          AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref WHERE ref.instance_id = i.id
            AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones tomb
              JOIN template_releases rel ON rel.id = i.identity_projection_release_id
              JOIN template_candidates candidate ON candidate.id = rel.candidate_id
              WHERE tomb.ref_hash = ref.ref_hash AND tomb.org_id = i.org_id AND tomb.mode = i.mode
                AND tomb.account_id = i.account_id AND tomb.release_id = rel.id AND tomb.candidate_id = candidate.id
                AND candidate.provider_account_id = i.account_id
                AND tomb.account_revision = candidate.provider_account_revision
                AND tomb.provider_identity_hash = candidate.provider_identity_hash)))
      )))
BEGIN SELECT RAISE(ABORT, 'credential transfer is not ready to complete'); END;

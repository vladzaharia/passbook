-- Provider epochs, PE5b (provider-epochs-design.md §3, 0079 there). The provider triggers compare the epochs the
-- operation snapshot records (pass row_version, account authority_epoch) instead of the pass version, revision and
-- account revision, and stop re-asserting the keyset singleton (the stored commitments still match it at insert).
-- A revoke is lineage only: it pins no pass content and no account epoch (D6).

DROP TRIGGER wallet_provider_generation_operation_guard;
CREATE TRIGGER wallet_provider_generation_operation_guard BEFORE INSERT ON wallet_provider_instance_operations
WHEN NOT EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id
  WHERE i.id = NEW.instance_id AND i.lifecycle IN ('active', 'revoking', 'revoked')
    AND i.account_id IS NOT NULL AND p.org_id = i.org_id AND p.mode = i.mode
    AND NEW.credential_keyset_commitment = i.credential_keyset_commitment
    AND i.credential_generation <= p.credential_generation
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id
      AND t.state = 'pending' AND t.source_generation = p.credential_generation)
    AND (NEW.kind = 'revoke' OR (i.lifecycle = 'active' AND i.retirement_requested_at IS NULL
      AND p.row_version = NEW.pass_row_version
      AND NEW.account_epoch = (SELECT a.authority_epoch FROM wallet_provider_accounts a WHERE a.id = i.account_id)
      AND p.lifecycle_generation = NEW.lifecycle_generation
      AND p.credential_generation = NEW.pass_credential_generation
      AND p.credential_generation = i.credential_generation
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')))
)
BEGIN SELECT RAISE(ABORT, 'provider operation is not authorized'); END;

DROP TRIGGER wallet_provider_instances_binding_immutable;
CREATE TRIGGER wallet_provider_instances_binding_immutable
BEFORE UPDATE OF account_id, identity_projection_release_id ON wallet_provider_instances
WHEN (OLD.account_id IS NOT NEW.account_id OR OLD.identity_projection_release_id IS NOT NEW.identity_projection_release_id)
  AND NOT (OLD.lifecycle = 'ready' AND NEW.lifecycle = 'active'
    AND OLD.account_id IS NULL AND OLD.identity_projection_release_id IS NULL
    AND NEW.account_id IS NOT NULL AND NEW.identity_projection_release_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM wallet_provider_accounts a
      JOIN template_releases r ON r.id = NEW.identity_projection_release_id
        AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider AND r.source = 'approved'
      JOIN template_candidates c ON c.id = r.candidate_id AND c.provider_account_id = a.id
        AND c.provider_account_epoch = a.authority_epoch
      JOIN wallet_provider_instance_operations op ON op.id = NEW.desired_operation_id
        AND op.instance_id = NEW.id AND op.version = NEW.desired_version AND op.kind = 'upsert'
        AND op.pass_credential_generation = NEW.credential_generation
      WHERE a.id = NEW.account_id AND a.org_id = NEW.org_id AND a.mode = NEW.mode
        AND a.provider = NEW.provider AND a.credential_id IS NOT NULL AND a.revoked_at IS NULL
    ))
BEGIN SELECT RAISE(ABORT, 'provider instance binding is immutable'); END;

DROP TRIGGER wallet_provider_generation_google_binding;
CREATE TRIGGER wallet_provider_generation_google_binding BEFORE INSERT ON wallet_google_callback_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id
  JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
    AND op.instance_id = i.id AND op.version = i.desired_version
  WHERE i.id = NEW.instance_id AND i.provider = 'google' AND i.lifecycle = 'active'
    AND i.account_id = NEW.account_id AND i.retirement_requested_at IS NULL
    AND p.org_id = i.org_id AND p.mode = i.mode AND p.credential_generation = i.credential_generation
    AND op.kind = 'upsert' AND op.pass_credential_generation = p.credential_generation
    AND NEW.credential_keyset_commitment = i.credential_keyset_commitment
    AND op.credential_keyset_commitment = i.credential_keyset_commitment
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')
)
BEGIN SELECT RAISE(ABORT, 'provider binding is not authorized'); END;

-- The transfer already pins source_row_version (0042); the version and revision pair is redundant with it.
DROP TRIGGER wallet_provider_generation_advance;
CREATE TRIGGER wallet_provider_generation_advance AFTER UPDATE OF credential_generation ON passes
WHEN NEW.credential_generation > OLD.credential_generation
BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
    OR NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
      WHERE t.pass_id = NEW.id AND t.org_id = NEW.org_id AND t.mode = NEW.mode AND t.state = 'pending'
        AND t.source_generation = OLD.credential_generation AND t.target_generation = NEW.credential_generation
        AND t.source_row_version = OLD.row_version
        AND t.source_lifecycle_generation = OLD.lifecycle_generation
        AND t.source_link_generation = NEW.link_generation AND NEW.link_generation = OLD.link_generation + 1
        AND NEW.download_token IS NOT OLD.download_token)
    THEN RAISE(ABORT, 'stale provider transfer') END;
  UPDATE wallet_provider_instances SET retirement_requested_at = MAX((SELECT requested_at
      FROM pass_credential_transfers WHERE pass_id = NEW.id AND state = 'pending'), created_at),
    updated_at = MAX((SELECT requested_at FROM pass_credential_transfers
      WHERE pass_id = NEW.id AND state = 'pending'), updated_at)
  WHERE pass_id = NEW.id AND credential_generation < NEW.credential_generation
    AND lifecycle != 'retired' AND retirement_requested_at IS NULL
    AND EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
      AND keyset.commitment = wallet_provider_instances.credential_keyset_commitment)
    AND (lifecycle IN ('blocked', 'ready') OR id IN (SELECT id FROM wallet_provider_pinned_desired));
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation, next_attempt_at)
    SELECT id, 1, 0 FROM wallet_provider_instances WHERE pass_id = NEW.id
      AND credential_generation < NEW.credential_generation AND lifecycle IN ('active', 'revoking', 'revoked')
      AND EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
        AND keyset.commitment = wallet_provider_instances.credential_keyset_commitment)
      AND id IN (SELECT id FROM wallet_provider_pinned_desired)
    ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
  UPDATE wallet_provider_instances SET lifecycle = 'retired', retirement_reason = 'not_issued',
    retired_at = MAX((SELECT requested_at FROM pass_credential_transfers
      WHERE pass_id = NEW.id AND state = 'pending'), created_at),
    updated_at = MAX((SELECT requested_at FROM pass_credential_transfers
      WHERE pass_id = NEW.id AND state = 'pending'), updated_at)
  WHERE pass_id = NEW.id AND credential_generation < NEW.credential_generation
    AND lifecycle IN ('blocked', 'ready')
    AND id IN (SELECT id FROM wallet_provider_unissued_placeholder)
    AND EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
      AND keyset.commitment = wallet_provider_instances.credential_keyset_commitment);
  INSERT INTO wallet_provider_instances
    (id, pass_id, org_id, mode, provider, credential_generation, credential_keyset_commitment,
      lifecycle, desired_version, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), NEW.id, NEW.org_id, NEW.mode, provider, NEW.credential_generation,
      keyset.commitment, 'blocked', 0, t.requested_at, t.requested_at
    FROM pass_credential_transfers t CROSS JOIN (SELECT 'google' AS provider UNION ALL SELECT 'samsung')
      JOIN credential_ref_keyset keyset ON keyset.id = 1
    WHERE t.pass_id = NEW.id AND t.state = 'pending' AND t.target_generation = NEW.credential_generation;
  SELECT CASE WHEN (SELECT COUNT(*) FROM wallet_provider_instances i
    JOIN wallet_provider_unissued_placeholder empty ON empty.id = i.id
    JOIN credential_ref_keyset keyset ON keyset.id = 1 AND keyset.commitment = i.credential_keyset_commitment
    WHERE i.pass_id = NEW.id AND i.org_id = NEW.org_id AND i.mode = NEW.mode
      AND i.credential_generation = NEW.credential_generation AND i.lifecycle = 'blocked'
      AND i.retirement_requested_at IS NULL AND i.provider IN ('google', 'samsung')) != 2
    THEN RAISE(ABORT, 'invalid blocked provider generation') END;
END;

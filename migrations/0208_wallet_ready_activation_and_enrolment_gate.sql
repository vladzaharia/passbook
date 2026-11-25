-- 1. A transfer's ready placeholder can take its first operation. The operation guard (0149) required an
-- active, bound instance, while the binding trigger activates a placeholder only after its first operation
-- exists: a new holder's tap after a transfer could never succeed. The guard gains one more way to pass: a
-- version 1 upsert on a ready placeholder (no account yet) of the pass's current generation, under the proof terms the
-- binding trigger checks (an approved release whose candidate names a current, credentialled, unrevoked account).
-- Every other guard term is unchanged.
--
-- 2. The enrolment gate (Off, Held, Revoked) applies to every account that has an enrolment row: one with a
-- credential_source_id (a migrated account keeps its legacy envelope but is Off until enabled) as well as one
-- without a legacy envelope. Only an account with a legacy envelope and no source stays exempt, as before.

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
AND NOT EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id
  WHERE i.id = NEW.instance_id AND NEW.kind = 'upsert' AND NEW.version = 1
    AND i.lifecycle = 'ready' AND i.account_id IS NULL AND i.retirement_requested_at IS NULL
    AND p.org_id = i.org_id AND p.mode = i.mode
    AND NEW.credential_keyset_commitment = i.credential_keyset_commitment
    AND p.row_version = NEW.pass_row_version
    AND p.lifecycle_generation = NEW.lifecycle_generation
    AND p.credential_generation = NEW.pass_credential_generation
    AND p.credential_generation = i.credential_generation
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')
    AND EXISTS (
      SELECT 1 FROM wallet_provider_accounts a
      JOIN template_releases r ON r.id = NEW.projection_release_id
        AND r.org_id = i.org_id AND r.mode = i.mode AND r.provider = i.provider AND r.source = 'approved'
      JOIN template_candidates c ON c.id = r.candidate_id AND c.provider_account_id = a.id
        AND c.provider_account_epoch = a.authority_epoch
      WHERE a.org_id = i.org_id AND a.mode = i.mode AND a.provider = i.provider
        AND COALESCE(a.credential_id, a.credential_source_id) IS NOT NULL AND a.revoked_at IS NULL
        AND NEW.account_epoch = a.authority_epoch
    )
)
BEGIN SELECT RAISE(ABORT, 'provider operation is not authorized'); END;

DROP TRIGGER wallet_enrolment_gate_instance_insert;
CREATE TRIGGER wallet_enrolment_gate_instance_insert BEFORE INSERT ON wallet_provider_instances
WHEN NEW.lifecycle = 'active' AND NEW.account_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM wallet_provider_accounts a WHERE a.id = NEW.account_id AND (a.credential_id IS NULL OR a.credential_source_id IS NOT NULL)
    AND (a.enabled_at IS NULL OR a.platform_hold_at IS NOT NULL OR a.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider enrolment is not on'); END;

DROP TRIGGER wallet_enrolment_gate_instance_activate;
CREATE TRIGGER wallet_enrolment_gate_instance_activate BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle != 'active' AND NEW.lifecycle = 'active' AND NEW.account_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM wallet_provider_accounts a WHERE a.id = NEW.account_id AND (a.credential_id IS NULL OR a.credential_source_id IS NOT NULL)
    AND (a.enabled_at IS NULL OR a.platform_hold_at IS NOT NULL OR a.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider enrolment is not on'); END;

DROP TRIGGER wallet_enrolment_gate_offer_insert;
CREATE TRIGGER wallet_enrolment_gate_offer_insert BEFORE INSERT ON wallet_provider_offer_refs
WHEN EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_accounts a ON a.id = i.account_id
  WHERE i.id = NEW.instance_id AND (a.credential_id IS NULL OR a.credential_source_id IS NOT NULL)
    AND (a.enabled_at IS NULL OR a.platform_hold_at IS NOT NULL OR a.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider enrolment is not on'); END;

DROP TRIGGER wallet_enrolment_gate_samsung_ref_insert;
CREATE TRIGGER wallet_enrolment_gate_samsung_ref_insert BEFORE INSERT ON wallet_samsung_fetch_refs
WHEN EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_accounts a ON a.id = i.account_id
  WHERE i.id = NEW.instance_id AND (a.credential_id IS NULL OR a.credential_source_id IS NOT NULL)
    AND (a.enabled_at IS NULL OR a.platform_hold_at IS NOT NULL OR a.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider enrolment is not on'); END;

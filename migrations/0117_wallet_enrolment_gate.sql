-- WA5: a new-model enrolment (no legacy envelope) that is Off, held or revoked cannot activate an
-- instance or gain an offer or fetch ref. Legacy rows keep today's guards. Added alongside the
-- 0043/0114 guards, which stay as they are.
CREATE TRIGGER wallet_enrolment_gate_instance_insert BEFORE INSERT ON wallet_provider_instances
WHEN NEW.lifecycle = 'active' AND NEW.account_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM wallet_provider_accounts a WHERE a.id = NEW.account_id AND a.credential_id IS NULL
    AND (a.enabled_at IS NULL OR a.platform_hold_at IS NOT NULL OR a.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider enrolment is not on'); END;

CREATE TRIGGER wallet_enrolment_gate_instance_activate BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle != 'active' AND NEW.lifecycle = 'active' AND NEW.account_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM wallet_provider_accounts a WHERE a.id = NEW.account_id AND a.credential_id IS NULL
    AND (a.enabled_at IS NULL OR a.platform_hold_at IS NOT NULL OR a.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider enrolment is not on'); END;

CREATE TRIGGER wallet_enrolment_gate_offer_insert BEFORE INSERT ON wallet_provider_offer_refs
WHEN EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_accounts a ON a.id = i.account_id
  WHERE i.id = NEW.instance_id AND a.credential_id IS NULL
    AND (a.enabled_at IS NULL OR a.platform_hold_at IS NOT NULL OR a.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider enrolment is not on'); END;

CREATE TRIGGER wallet_enrolment_gate_samsung_ref_insert BEFORE INSERT ON wallet_samsung_fetch_refs
WHEN EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_accounts a ON a.id = i.account_id
  WHERE i.id = NEW.instance_id AND a.credential_id IS NULL
    AND (a.enabled_at IS NULL OR a.platform_hold_at IS NOT NULL OR a.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider enrolment is not on'); END;

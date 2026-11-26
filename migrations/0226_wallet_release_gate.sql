-- The platform release of Google and Samsung per mode (cross-wallet plan 4.2, TURN-0). RELEASE in
-- src/worker/modules/wallet-providers/release.ts is the Worker's copy; release-mirror.test.ts and
-- tools/check-migrations.ts fail when the two differ. dark: nothing issues. released: an org issues through its plan
-- and an enrolment that is On. draining: the rollback; nothing new issues, revokes still reach copies already added.
-- A flip is one RELEASE cell plus one migration with one canonical UPDATE of the same row (docs/operations.md,
-- "Wallet release").
--
-- The five issuance guards of 0114 are replaced in place: each keeps its body and refuses only while its provider
-- and mode are not released. With every row dark, each refuses what it refused before. Two terms stay on when
-- released: the insert guard's keyset match (keyset-guards.test.ts names it the instance table's keyset trigger) and
-- its refusal of a copy inserted already retiring. Successors (channel_epoch > 1) join the release rule, so a
-- draining channel cannot come back on.
--
-- The legacy-envelope exemption (a credential_id with no source issued with no enrolment) leaves the four enrolment
-- gate triggers of 0208 and the successor rule of 0207: only an enrolment that is On issues.

CREATE TABLE wallet_provider_releases (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'samsung')),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  state TEXT NOT NULL CHECK (state IN ('dark', 'draining', 'released')),
  changed_at INTEGER NOT NULL CHECK (typeof(changed_at) = 'integer' AND changed_at >= 0),
  PRIMARY KEY (provider, mode)
);
INSERT INTO wallet_provider_releases (provider, mode, state, changed_at) VALUES
  ('google', 'live', 'dark', 0),
  ('google', 'test', 'dark', 0),
  ('samsung', 'live', 'dark', 0),
  ('samsung', 'test', 'dark', 0);
CREATE TRIGGER wallet_provider_releases_no_insert BEFORE INSERT ON wallet_provider_releases
BEGIN SELECT RAISE(ABORT, 'wallet release rows are fixed'); END;
CREATE TRIGGER wallet_provider_releases_no_delete BEFORE DELETE ON wallet_provider_releases
BEGIN SELECT RAISE(ABORT, 'wallet release rows are fixed'); END;
CREATE TRIGGER wallet_provider_releases_fixed BEFORE UPDATE OF provider, mode ON wallet_provider_releases
WHEN NEW.provider IS NOT OLD.provider OR NEW.mode IS NOT OLD.mode
BEGIN SELECT RAISE(ABORT, 'wallet release rows are fixed'); END;
-- Dark again only once every copy of that provider and mode is retired: a void reaches each one first (draining).
CREATE TRIGGER wallet_provider_releases_dark_retired BEFORE UPDATE OF state ON wallet_provider_releases
WHEN NEW.state = 'dark' AND OLD.state != 'dark' AND EXISTS (
  SELECT 1 FROM wallet_provider_instances i WHERE i.provider = NEW.provider AND i.mode = NEW.mode
    AND i.lifecycle != 'retired')
BEGIN SELECT RAISE(ABORT, 'wallet release cannot go dark while copies exist; drain it first'); END;

DROP TRIGGER wallet_provider_generation_insert_guard;
CREATE TRIGGER wallet_provider_generation_insert_guard BEFORE INSERT ON wallet_provider_instances
WHEN (NEW.channel_epoch = 1 AND (NEW.retirement_requested_at IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
      AND keyset.commitment = NEW.credential_keyset_commitment)))
  OR (NOT EXISTS (SELECT 1 FROM wallet_provider_releases release WHERE release.provider = NEW.provider
      AND release.mode = NEW.mode AND release.state = 'released')
    AND (NEW.channel_epoch != 1 OR NEW.lifecycle != 'blocked' OR NOT EXISTS (
      SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode
        AND NEW.credential_generation > 1
        AND p.credential_generation = NEW.credential_generation
        AND EXISTS (SELECT 1 FROM pass_credential_transfers pending WHERE pending.pass_id = p.id
          AND pending.org_id = p.org_id AND pending.mode = p.mode AND pending.state = 'pending'
          AND pending.target_generation = NEW.credential_generation)
        AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
          WHERE t.pass_id = p.id AND t.target_generation = NEW.credential_generation AND t.state = 'completed')
        AND NOT EXISTS (SELECT 1 FROM wallet_provider_instances current
          WHERE current.pass_id = p.id AND current.provider = NEW.provider
            AND current.credential_generation = NEW.credential_generation)
    )))
BEGIN SELECT RAISE(ABORT, 'provider issuance is unavailable'); END;

DROP TRIGGER wallet_provider_generation_binding_guard;
CREATE TRIGGER wallet_provider_generation_binding_guard BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle = 'ready' AND NEW.lifecycle = 'active' AND NOT EXISTS (
  SELECT 1 FROM wallet_provider_releases release WHERE release.provider = NEW.provider
    AND release.mode = NEW.mode AND release.state = 'released')
BEGIN SELECT RAISE(ABORT, 'provider issuance is unavailable'); END;

DROP TRIGGER wallet_provider_generation_offer_insert;
CREATE TRIGGER wallet_provider_generation_offer_insert BEFORE INSERT ON wallet_provider_offer_refs
WHEN NOT EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_releases release
    ON release.provider = i.provider AND release.mode = i.mode AND release.state = 'released'
  WHERE i.id = NEW.instance_id)
BEGIN SELECT RAISE(ABORT, 'provider offer is unavailable'); END;

DROP TRIGGER wallet_provider_generation_offer_consume;
CREATE TRIGGER wallet_provider_generation_offer_consume
BEFORE UPDATE OF consumed_at, delivered_at ON wallet_provider_offer_refs
WHEN ((NEW.consumed_at IS NOT OLD.consumed_at AND NEW.consumed_at IS NOT NULL)
  OR (NEW.delivered_at IS NOT OLD.delivered_at AND NEW.delivered_at IS NOT NULL))
  AND NOT EXISTS (
    SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_releases release
      ON release.provider = i.provider AND release.mode = i.mode AND release.state = 'released'
    WHERE i.id = NEW.instance_id)
BEGIN SELECT RAISE(ABORT, 'provider offer is unavailable'); END;

DROP TRIGGER wallet_provider_generation_samsung_ref;
CREATE TRIGGER wallet_provider_generation_samsung_ref BEFORE INSERT ON wallet_samsung_fetch_refs
WHEN NOT EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_releases release
    ON release.provider = i.provider AND release.mode = i.mode AND release.state = 'released'
  WHERE i.id = NEW.instance_id)
BEGIN SELECT RAISE(ABORT, 'provider reference is unavailable'); END;

DROP TRIGGER wallet_enrolment_gate_instance_insert;
CREATE TRIGGER wallet_enrolment_gate_instance_insert BEFORE INSERT ON wallet_provider_instances
WHEN NEW.lifecycle = 'active' AND NEW.account_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM wallet_provider_accounts a WHERE a.id = NEW.account_id
    AND (a.enabled_at IS NULL OR a.platform_hold_at IS NOT NULL OR a.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider enrolment is not on'); END;

DROP TRIGGER wallet_enrolment_gate_instance_activate;
CREATE TRIGGER wallet_enrolment_gate_instance_activate BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle != 'active' AND NEW.lifecycle = 'active' AND NEW.account_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM wallet_provider_accounts a WHERE a.id = NEW.account_id
    AND (a.enabled_at IS NULL OR a.platform_hold_at IS NOT NULL OR a.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider enrolment is not on'); END;

DROP TRIGGER wallet_enrolment_gate_offer_insert;
CREATE TRIGGER wallet_enrolment_gate_offer_insert BEFORE INSERT ON wallet_provider_offer_refs
WHEN EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_accounts a ON a.id = i.account_id
  WHERE i.id = NEW.instance_id
    AND (a.enabled_at IS NULL OR a.platform_hold_at IS NOT NULL OR a.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider enrolment is not on'); END;

DROP TRIGGER wallet_enrolment_gate_samsung_ref_insert;
CREATE TRIGGER wallet_enrolment_gate_samsung_ref_insert BEFORE INSERT ON wallet_samsung_fetch_refs
WHEN EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_accounts a ON a.id = i.account_id
  WHERE i.id = NEW.instance_id
    AND (a.enabled_at IS NULL OR a.platform_hold_at IS NOT NULL OR a.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider enrolment is not on'); END;

DROP TRIGGER wallet_provider_instances_successor;
CREATE TRIGGER wallet_provider_instances_successor BEFORE INSERT ON wallet_provider_instances
WHEN NEW.channel_epoch > 1 AND (
  NEW.lifecycle != 'active' OR NEW.retirement_requested_at IS NOT NULL OR NEW.retirement_cause IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
    AND keyset.commitment = NEW.credential_keyset_commitment)
  OR NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode
    AND p.credential_generation = NEW.credential_generation)
  OR EXISTS (SELECT 1 FROM pass_credential_transfers pending WHERE pending.pass_id = NEW.pass_id
    AND pending.state = 'pending')
  OR NOT EXISTS (
    SELECT 1 FROM wallet_provider_accounts a
    JOIN template_releases r ON r.id = NEW.identity_projection_release_id
      AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider AND r.source = 'approved'
    JOIN template_candidates c ON c.id = r.candidate_id AND c.provider_account_id = a.id
      AND c.provider_account_revision = a.revision
    WHERE a.id = NEW.account_id AND a.org_id = NEW.org_id AND a.mode = NEW.mode
      AND a.provider = NEW.provider AND COALESCE(a.credential_id, a.credential_source_id) IS NOT NULL AND a.revoked_at IS NULL
      AND a.enabled_at IS NOT NULL AND a.platform_hold_at IS NULL
  )
  OR NOT EXISTS (
    SELECT 1 FROM wallet_provider_instances pred
    WHERE pred.pass_id = NEW.pass_id AND pred.provider = NEW.provider
      AND pred.credential_generation = NEW.credential_generation AND pred.channel_epoch = NEW.channel_epoch - 1
      AND pred.org_id = NEW.org_id AND pred.mode = NEW.mode
      AND pred.retirement_cause = 'channel_off' AND pred.lifecycle IN ('revoked', 'retired')
      AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.id = pred.desired_operation_id
        AND op.instance_id = pred.id AND op.kind = 'revoke' AND op.state = 'succeeded')
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy WHERE busy.instance_id = pred.id
        AND busy.state IN ('pending', 'retry', 'claimed', 'uncertain'))
  )
  OR EXISTS (SELECT 1 FROM pass_channels c WHERE c.pass_id = NEW.pass_id AND c.channel = NEW.provider
    AND c.retired_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider successor is not allowed'); END;

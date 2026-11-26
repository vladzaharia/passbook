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
-- draining channel cannot come back on. Once released, a copy inserted active needs the same approved-release proof
-- a placeholder needs to activate (0207 binding rule).
--
-- Draining refuses in the database too: an un-void (revoking or revoked back to active) and every operation but a
-- revoke (an update, a message's upsert; a trigger beside the 0208 operation guard). Dark needs neither term: no
-- copy can be active, revoking or revoked there (going dark needs none open), so the 0208 rules already refuse.

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
-- Dark again only once no copy of that provider and mode can still be in a wallet: a void reaches each one first
-- (draining). Placeholders that never got an account never reached one. tools/deploy.ts refuses such a migration
-- before it runs; this is the backstop.
CREATE TRIGGER wallet_provider_releases_dark_retired BEFORE UPDATE OF state ON wallet_provider_releases
WHEN NEW.state = 'dark' AND OLD.state != 'dark' AND EXISTS (
  SELECT 1 FROM wallet_provider_instances i WHERE i.provider = NEW.provider AND i.mode = NEW.mode
    AND (i.lifecycle IN ('active', 'revoking', 'revoked') OR (i.account_id IS NOT NULL AND i.lifecycle != 'retired')))
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
  OR (NEW.channel_epoch = 1 AND NEW.lifecycle = 'active' AND NOT EXISTS (
    SELECT 1 FROM wallet_provider_accounts a
    JOIN template_releases r ON r.id = NEW.identity_projection_release_id
      AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider AND r.source = 'approved'
    JOIN template_candidates c ON c.id = r.candidate_id AND c.provider_account_id = a.id
      AND c.provider_account_epoch = a.authority_epoch
    WHERE a.id = NEW.account_id AND a.org_id = NEW.org_id AND a.mode = NEW.mode AND a.provider = NEW.provider
      AND COALESCE(a.credential_id, a.credential_source_id) IS NOT NULL AND a.revoked_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'provider issuance is unavailable'); END;

DROP TRIGGER wallet_provider_generation_binding_guard;
CREATE TRIGGER wallet_provider_generation_binding_guard BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN (OLD.lifecycle = 'ready' AND NEW.lifecycle = 'active' AND NOT EXISTS (
    SELECT 1 FROM wallet_provider_releases release WHERE release.provider = NEW.provider
      AND release.mode = NEW.mode AND release.state = 'released'))
  OR (OLD.lifecycle IN ('revoking', 'revoked') AND NEW.lifecycle = 'active' AND EXISTS (
    SELECT 1 FROM wallet_provider_releases release WHERE release.provider = NEW.provider
      AND release.mode = NEW.mode AND release.state = 'draining'))
BEGIN SELECT RAISE(ABORT, 'provider issuance is unavailable'); END;

CREATE TRIGGER wallet_provider_generation_operation_draining BEFORE INSERT ON wallet_provider_instance_operations
WHEN NEW.kind != 'revoke' AND EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_releases release
    ON release.provider = i.provider AND release.mode = i.mode AND release.state = 'draining'
  WHERE i.id = NEW.instance_id)
BEGIN SELECT RAISE(ABORT, 'provider is draining: only a revoke is sent'); END;

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

-- ENR-REV. Enrolment accounts issue; legacy accounts end.
--
-- 1. The candidate insert proof compares the revision the Worker pins (an enrolment-only row keeps it in
-- enrolment_revision; wallet_provider_accounts.revision is 0 there) and the authority epoch. The successor proof pins
-- the epoch, as the binding trigger and the operation guard do: enrolment_revision moves on every enable, disable and
-- hold, and would strand successors. Both are the 0207 bodies with those terms changed.
--
-- 2. The legacy exemption goes. The four enrolment gate triggers (0208 bodies) and the successor refuse unless the
-- account is On and not held, whatever its envelope.
--
-- 3. No new legacy account: credential_id may not go from NULL to set, or be inserted set, without a
-- credential_source_id. A migrated or rotated legacy row is unaffected.

DROP TRIGGER template_provider_candidates_insert;
CREATE TRIGGER template_provider_candidates_insert BEFORE INSERT ON template_candidates
WHEN NEW.provider IN ('google', 'samsung') AND NOT EXISTS (
  SELECT 1 FROM template_provider_apple_sources s
  JOIN template_versions v ON v.template_id = s.template_id AND v.version = s.version
  JOIN wallet_provider_accounts account ON account.id = NEW.provider_account_id
    AND account.org_id = NEW.org_id AND account.mode = NEW.mode AND account.provider = NEW.provider
    AND (CASE WHEN account.credential_id IS NULL THEN account.enrolment_revision ELSE account.revision END)
      = NEW.provider_account_revision
    AND account.authority_epoch = NEW.provider_account_epoch
    AND COALESCE(account.credential_id, account.credential_source_id) IS NOT NULL
    AND account.revoked_at IS NULL
  WHERE NEW.org_id IS NOT NULL AND s.id = NEW.source_release_id
    AND s.template_id = NEW.template_id AND s.mode = NEW.mode AND s.version = NEW.version
    AND (s.org_id = NEW.org_id OR (s.org_id IS NULL AND s.origin = 'baked' AND s.template_org_id IS NULL))
    AND s.generation = NEW.source_release_generation AND s.candidate_hash = NEW.source_release_hash
    AND s.content_hash = NEW.content_hash AND v.created_by IS NEW.version_author_id
    AND NEW.projection_json IS NOT NULL AND json_valid(NEW.projection_json)
    AND json_type(NEW.projection_json) = 'object'
    AND length(NEW.provider_identity_hash) = 64 AND NEW.provider_identity_hash NOT GLOB '*[^0-9a-f]*'
    AND json_extract(NEW.projection_json, '$.provider') = NEW.provider
    AND NEW.adapter_revision = 1 AND NEW.audience_policy_revision = 1
    AND ((NEW.provider = 'google' AND NEW.adapter_capabilities = '["generic-text","qr-code","reviewed-artwork"]')
      OR (NEW.provider = 'samsung' AND NEW.adapter_capabilities = '["loyalty-text","qr-code","reviewed-artwork"]'))
)
BEGIN SELECT RAISE(ABORT, 'invalid provider projection candidate'); END;

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
      AND c.provider_account_epoch = a.authority_epoch
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

CREATE TRIGGER wallet_provider_accounts_no_new_legacy_insert BEFORE INSERT ON wallet_provider_accounts
WHEN NEW.credential_id IS NOT NULL AND NEW.credential_source_id IS NULL
BEGIN SELECT RAISE(ABORT, 'legacy wallet accounts are closed; use an enrolment'); END;
CREATE TRIGGER wallet_provider_accounts_no_new_legacy_update BEFORE UPDATE OF credential_id, credential_source_id ON wallet_provider_accounts
WHEN OLD.credential_id IS NULL AND NEW.credential_id IS NOT NULL AND NEW.credential_source_id IS NULL
BEGIN SELECT RAISE(ABORT, 'legacy wallet accounts are closed; use an enrolment'); END;

-- 4. A Samsung tombstone's insert proof (0199 body) asked for the account's configure event at the tombstone's
-- revision, which an enrolment account does not have. It now also accepts the version the tombstone pins: a version
-- of a Samsung credential the org may use, on an account with a source. Every other term is unchanged.

DROP TRIGGER wallet_samsung_tombstones_approved_insert;
CREATE TRIGGER wallet_samsung_tombstones_approved_insert BEFORE INSERT ON wallet_samsung_tombstones
WHEN NOT EXISTS (
  SELECT 1 FROM wallet_provider_accounts a LEFT JOIN wallet_provider_account_events e
    ON e.account_id = a.id AND e.org_id = a.org_id AND e.mode = a.mode AND e.provider = a.provider
    AND e.revision = NEW.account_revision AND e.kind = 'configure'
  JOIN template_candidates c ON c.id = NEW.candidate_id AND c.provider_account_id = a.id
    AND c.provider_account_revision = NEW.account_revision AND c.provider_identity_hash = NEW.provider_identity_hash
    AND c.org_id = NEW.org_id AND c.mode = NEW.mode AND c.provider = 'samsung'
  JOIN template_releases r ON r.id = NEW.release_id AND r.candidate_id = c.id
    AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = 'samsung' AND r.source = 'approved'
  LEFT JOIN wallet_provider_projection_evidence_history h ON h.candidate_id = c.id AND h.org_id = c.org_id
    AND h.mode = c.mode AND h.account_id = a.id AND h.account_revision = NEW.account_revision
    AND h.provider_identity_hash = NEW.provider_identity_hash AND h.candidate_hash = c.candidate_hash
    AND h.card_type = json_extract(c.projection_json, '$.cardType')
    AND h.card_sub_type = json_extract(c.projection_json, '$.cardSubType')
    AND h.country_code = json_extract(c.projection_json, '$.countryCode')
    AND h.testing_mode_off = 'Y' AND h.verified_at <= r.created_at AND r.created_at < h.expires_at
  WHERE a.id = NEW.account_id AND a.org_id = NEW.org_id AND a.mode = NEW.mode AND a.provider = 'samsung'
    AND (e.id IS NOT NULL OR (a.credential_source_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM wallet_credential_versions pin_v
      JOIN wallet_credentials pin_c ON pin_c.id = pin_v.credential_id AND pin_c.mode = NEW.mode
        AND pin_c.provider = 'samsung' AND (pin_c.scope = 'platform' OR pin_c.org_id = NEW.org_id)
      WHERE pin_v.id = NEW.credential_version_id)))
    AND (json_extract(c.projection_json, '$.schema') = 2 OR h.candidate_id IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'Samsung tombstone requires verified release evidence'); END;

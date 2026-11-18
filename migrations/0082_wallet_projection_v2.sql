-- CW7: Google releases open, on schema 2 projections only. A schema 2 candidate pins the compiler
-- revision, the wallets hash, the report hash and the approved omissions (architecture 4.3), so
-- the Samsung card-state evidence no longer gates a Google release. Schema 1 stays what Samsung
-- publishes until its runtime moves to the compiler. Everything else in the trigger is 0038's.
-- Numbered 0082: 0076-0081 are reserved for the provider-epochs track.
DROP TRIGGER template_provider_releases_insert;

CREATE TRIGGER template_provider_releases_insert BEFORE INSERT ON template_releases
WHEN NEW.provider IN ('google', 'samsung')
BEGIN
  SELECT CASE WHEN NEW.source != 'approved' OR NEW.org_id IS NULL
    OR NEW.generation != COALESCE((SELECT MAX(r.generation) FROM template_releases r
      WHERE r.template_id = NEW.template_id AND r.org_id = NEW.org_id
        AND r.mode = NEW.mode AND r.provider = NEW.provider), 0) + 1
    OR NEW.previous_release_id IS NOT (SELECT r.id FROM template_releases r
      WHERE r.template_id = NEW.template_id AND r.org_id = NEW.org_id
        AND r.mode = NEW.mode AND r.provider = NEW.provider ORDER BY r.generation DESC LIMIT 1)
    THEN RAISE(ABORT, 'stale provider release') END;
  -- Validate the same immutable candidate in bounded predicates: combining the expanded
  -- Apple source view and nested provider evidence exceeds D1's expression-depth limit.
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM template_candidates c JOIN template_approvals a ON a.candidate_id = c.id
    JOIN template_versions v ON v.template_id = c.template_id AND v.version = c.version
    JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
      AND account.org_id = c.org_id AND account.mode = c.mode AND account.provider = c.provider
      AND account.revision = c.provider_account_revision
      AND account.credential_id IS NOT NULL
      AND account.revoked_at IS NULL
    WHERE c.id = NEW.candidate_id AND a.id = NEW.approval_id AND c.template_id = NEW.template_id
      AND c.org_id = NEW.org_id AND c.mode = NEW.mode AND c.provider = NEW.provider AND c.version = NEW.version
      AND c.candidate_hash = NEW.candidate_hash AND a.candidate_hash = c.candidate_hash
      AND c.content_hash = NEW.content_hash AND c.adapter_revision = NEW.adapter_revision
      AND c.adapter_capabilities = NEW.adapter_capabilities AND c.audience_policy_revision = NEW.audience_policy_revision
      AND a.reviewer_id != c.author_id AND (c.version_author_id IS NULL OR a.reviewer_id != c.version_author_id)
      AND NEW.created_by IS NOT NULL
      AND v.created_by IS c.version_author_id AND c.projection_json IS NOT NULL
      AND json_extract(c.projection_json, '$.schema') = CASE c.provider WHEN 'google' THEN 2 ELSE 1 END
      AND c.adapter_revision = 1 AND c.audience_policy_revision = 1
      AND ((c.provider = 'google' AND c.adapter_capabilities = '["generic-text","qr-code","reviewed-artwork"]')
        OR (c.provider = 'samsung' AND c.adapter_capabilities = '["loyalty-text","qr-code","reviewed-artwork"]'))
  ) THEN RAISE(ABORT, 'invalid provider release approval or source') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM template_candidates c
    JOIN template_provider_apple_sources s ON s.id = c.source_release_id
    WHERE c.id = NEW.candidate_id
      AND s.template_id = c.template_id AND s.mode = c.mode AND s.version = c.version
      AND (s.org_id = c.org_id OR (s.org_id IS NULL AND s.origin = 'baked' AND s.template_org_id IS NULL))
      AND s.generation = c.source_release_generation AND s.candidate_hash = c.source_release_hash
      AND s.content_hash = c.content_hash
  ) THEN RAISE(ABORT, 'invalid provider release approval or source') END;
  -- Operator review is not provider proof. Samsung needs verified card state. Google has no
  -- documented status proof, so its release rests on the compiled schema 2 pins checked above.
  SELECT CASE WHEN NEW.provider = 'samsung' AND NOT EXISTS (
    SELECT 1 FROM template_candidates c
    JOIN wallet_provider_projection_evidence ev ON ev.candidate_id = c.id
    WHERE c.id = NEW.candidate_id AND c.provider = 'samsung'
      AND ev.org_id = c.org_id AND ev.mode = c.mode
      AND ev.account_id = c.provider_account_id AND ev.account_revision = c.provider_account_revision
      AND ev.provider_identity_hash = c.provider_identity_hash AND ev.candidate_hash = c.candidate_hash
      AND ev.card_type = json_extract(c.projection_json, '$.cardType')
      AND ev.card_sub_type = json_extract(c.projection_json, '$.cardSubType')
      AND ev.country_code = json_extract(c.projection_json, '$.countryCode')
      AND ev.status = 'verified' AND ev.testing_mode_off = 'Y'
      AND ev.verified_at <= NEW.created_at AND ev.expires_at > NEW.created_at
      AND ev.expires_at > ev.verified_at AND ev.expires_at <= ev.verified_at + 300000
  ) THEN RAISE(ABORT, 'invalid provider release approval or source') END;
  SELECT CASE WHEN NEW.provider = 'samsung' AND NOT EXISTS (
    SELECT 1 FROM wallet_provider_projection_evidence ev
    JOIN wallet_provider_projection_evidence_history eh ON eh.id = ev.probe_id
    WHERE ev.candidate_id = NEW.candidate_id AND eh.candidate_id = ev.candidate_id
      AND eh.org_id = ev.org_id AND eh.mode = ev.mode
      AND eh.account_id = ev.account_id AND eh.account_revision = ev.account_revision
      AND eh.candidate_hash = ev.candidate_hash AND eh.provider_identity_hash = ev.provider_identity_hash
      AND eh.card_type = ev.card_type AND eh.card_sub_type = ev.card_sub_type
      AND eh.country_code = ev.country_code AND eh.testing_mode_off = ev.testing_mode_off
      AND eh.verified_at = ev.verified_at AND eh.expires_at = ev.expires_at
  ) THEN RAISE(ABORT, 'invalid provider release approval or source') END;
  SELECT CASE WHEN NEW.action = 'release' AND EXISTS (
    SELECT 1 FROM template_releases r WHERE r.candidate_id = NEW.candidate_id AND r.source = 'approved'
  ) THEN RAISE(ABORT, 'provider candidate already released') END;
  SELECT CASE WHEN NEW.action = 'rollback' AND NOT EXISTS (
    SELECT 1 FROM template_releases r WHERE r.id = NEW.rollback_of_release_id AND r.source = 'approved'
      AND r.template_id = NEW.template_id AND r.org_id = NEW.org_id AND r.mode = NEW.mode
      AND r.provider = NEW.provider AND r.generation < NEW.generation - 1
      AND r.candidate_id = NEW.candidate_id AND r.approval_id = NEW.approval_id
      AND r.candidate_hash = NEW.candidate_hash AND r.version = NEW.version
  ) THEN RAISE(ABORT, 'invalid provider rollback') END;
  SELECT CASE WHEN NEW.adapter_revision < COALESCE((
    SELECT r.adapter_revision FROM template_releases r WHERE r.template_id = NEW.template_id
      AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider
    ORDER BY r.generation DESC LIMIT 1), 0) OR NEW.audience_policy_revision < COALESCE((
    SELECT r.audience_policy_revision FROM template_releases r WHERE r.template_id = NEW.template_id
      AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider
    ORDER BY r.generation DESC LIMIT 1), 0) THEN RAISE(ABORT, 'stale provider policy') END;
END;

-- SQLite fires BEFORE triggers newest first. 0043's keyset check ran before the trigger above;
-- recreate it unchanged so it still does.
DROP TRIGGER wallet_provider_release_keyset_insert;
CREATE TRIGGER wallet_provider_release_keyset_insert BEFORE INSERT ON template_releases
WHEN NEW.provider IN ('google', 'samsung') AND NOT EXISTS (
  SELECT 1 FROM template_candidates c JOIN credential_ref_keyset keyset
    ON keyset.id = 1 AND keyset.commitment = c.credential_keyset_commitment
  JOIN template_approvals approval ON approval.id = NEW.approval_id AND approval.candidate_id = c.id
  WHERE c.id = NEW.candidate_id AND c.provider = NEW.provider
    AND c.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND approval.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND (NEW.action != 'rollback' OR EXISTS (SELECT 1 FROM template_releases prior
      WHERE prior.id = NEW.rollback_of_release_id
        AND prior.credential_keyset_commitment = NEW.credential_keyset_commitment)))
BEGIN SELECT RAISE(ABORT, 'provider release keyset unavailable'); END;

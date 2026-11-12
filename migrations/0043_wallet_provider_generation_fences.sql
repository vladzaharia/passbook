-- Historic provider authority predates the keyset fence. Leave its commitment NULL rather
-- than adopting today's key: recovery of such rows requires a separately reviewed migration.
ALTER TABLE wallet_provider_instances ADD COLUMN credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE wallet_provider_instance_operations ADD COLUMN credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE wallet_google_callback_bindings ADD COLUMN credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE wallet_samsung_fetch_refs ADD COLUMN credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE wallet_samsung_tombstones ADD COLUMN credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE template_candidates ADD COLUMN credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE template_approvals ADD COLUMN credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE template_releases ADD COLUMN credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE wallet_provider_projection_evidence ADD COLUMN credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE wallet_provider_projection_evidence_history ADD COLUMN credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'));

CREATE TRIGGER wallet_provider_candidate_keyset_insert BEFORE INSERT ON template_candidates
WHEN NEW.provider IN ('google', 'samsung') AND NOT EXISTS (
  SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
    AND keyset.commitment = NEW.credential_keyset_commitment)
BEGIN SELECT RAISE(ABORT, 'provider candidate keyset unavailable'); END;
CREATE TRIGGER wallet_provider_approval_keyset_insert BEFORE INSERT ON template_approvals
WHEN EXISTS (SELECT 1 FROM template_candidates c WHERE c.id = NEW.candidate_id AND c.provider IN ('google', 'samsung'))
  AND NOT EXISTS (SELECT 1 FROM template_candidates c JOIN credential_ref_keyset keyset
    ON keyset.id = 1 AND keyset.commitment = c.credential_keyset_commitment
    WHERE c.id = NEW.candidate_id AND c.provider IN ('google', 'samsung')
      AND c.credential_keyset_commitment = NEW.credential_keyset_commitment)
BEGIN SELECT RAISE(ABORT, 'provider approval keyset unavailable'); END;
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
CREATE TRIGGER wallet_provider_evidence_keyset_insert BEFORE INSERT ON wallet_provider_projection_evidence
WHEN NOT EXISTS (SELECT 1 FROM template_candidates c JOIN credential_ref_keyset keyset
  ON keyset.id = 1 AND keyset.commitment = c.credential_keyset_commitment
  WHERE c.id = NEW.candidate_id AND c.provider = 'samsung'
    AND c.credential_keyset_commitment = NEW.credential_keyset_commitment)
BEGIN SELECT RAISE(ABORT, 'provider evidence keyset unavailable'); END;
CREATE TRIGGER wallet_provider_evidence_keyset_update BEFORE UPDATE ON wallet_provider_projection_evidence
WHEN NEW.credential_keyset_commitment IS NOT OLD.credential_keyset_commitment
  OR NOT EXISTS (SELECT 1 FROM template_candidates c JOIN credential_ref_keyset keyset
    ON keyset.id = 1 AND keyset.commitment = c.credential_keyset_commitment
    WHERE c.id = OLD.candidate_id AND c.provider = 'samsung'
      AND c.credential_keyset_commitment = OLD.credential_keyset_commitment)
BEGIN SELECT RAISE(ABORT, 'provider evidence keyset unavailable'); END;
CREATE TRIGGER wallet_provider_evidence_history_keyset_insert BEFORE INSERT ON wallet_provider_projection_evidence_history
WHEN NOT EXISTS (SELECT 1 FROM template_candidates c JOIN credential_ref_keyset keyset
    ON keyset.id = 1 AND keyset.commitment = c.credential_keyset_commitment
  JOIN wallet_provider_projection_evidence evidence ON evidence.candidate_id = c.id
  WHERE c.id = NEW.candidate_id AND c.provider = 'samsung' AND evidence.probe_id = NEW.id
    AND c.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND evidence.credential_keyset_commitment = NEW.credential_keyset_commitment)
BEGIN SELECT RAISE(ABORT, 'provider evidence keyset unavailable'); END;
CREATE TRIGGER wallet_samsung_tombstone_keyset_insert BEFORE INSERT ON wallet_samsung_tombstones
WHEN NOT EXISTS (SELECT 1 FROM template_releases projection_release
  JOIN template_candidates candidate ON candidate.id = projection_release.candidate_id
  JOIN template_approvals approval ON approval.id = projection_release.approval_id AND approval.candidate_id = candidate.id
  JOIN wallet_provider_projection_evidence_history evidence ON evidence.candidate_id = candidate.id
  JOIN credential_ref_keyset keyset ON keyset.id = 1 AND keyset.commitment = NEW.credential_keyset_commitment
  WHERE projection_release.id = NEW.release_id AND candidate.id = NEW.candidate_id
    AND projection_release.org_id = NEW.org_id AND projection_release.mode = NEW.mode AND projection_release.provider = 'samsung'
    AND candidate.provider_account_id = NEW.account_id AND candidate.provider_account_revision = NEW.account_revision
    AND candidate.provider_identity_hash = NEW.provider_identity_hash
    AND candidate.org_id = NEW.org_id AND candidate.mode = NEW.mode AND candidate.provider = 'samsung'
    AND projection_release.source = 'approved' AND projection_release.candidate_hash = candidate.candidate_hash
    AND approval.candidate_hash = candidate.candidate_hash AND approval.reviewer_id != candidate.author_id
    AND (candidate.version_author_id IS NULL OR approval.reviewer_id != candidate.version_author_id)
    AND projection_release.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND candidate.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND approval.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND evidence.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND evidence.org_id = NEW.org_id AND evidence.mode = NEW.mode AND evidence.account_id = NEW.account_id
    AND evidence.account_revision = NEW.account_revision AND evidence.candidate_hash = candidate.candidate_hash
    AND evidence.provider_identity_hash = NEW.provider_identity_hash
    AND evidence.card_type = json_extract(candidate.projection_json, '$.cardType')
    AND evidence.card_sub_type = json_extract(candidate.projection_json, '$.cardSubType')
    AND evidence.country_code = json_extract(candidate.projection_json, '$.countryCode')
    AND evidence.testing_mode_off = 'Y' AND evidence.verified_at <= projection_release.created_at
    AND projection_release.created_at < evidence.expires_at)
BEGIN SELECT RAISE(ABORT, 'Samsung tombstone keyset unavailable'); END;

CREATE TRIGGER wallet_provider_instance_keyset_immutable BEFORE UPDATE OF credential_keyset_commitment ON wallet_provider_instances
WHEN NEW.credential_keyset_commitment IS NOT OLD.credential_keyset_commitment
BEGIN SELECT RAISE(ABORT, 'provider keyset commitment is immutable'); END;
CREATE TRIGGER wallet_provider_operation_keyset_immutable BEFORE UPDATE OF credential_keyset_commitment ON wallet_provider_instance_operations
WHEN NEW.credential_keyset_commitment IS NOT OLD.credential_keyset_commitment
BEGIN SELECT RAISE(ABORT, 'provider keyset commitment is immutable'); END;
CREATE TRIGGER wallet_google_binding_keyset_immutable BEFORE UPDATE OF credential_keyset_commitment ON wallet_google_callback_bindings
WHEN NEW.credential_keyset_commitment IS NOT OLD.credential_keyset_commitment
BEGIN SELECT RAISE(ABORT, 'provider keyset commitment is immutable'); END;
CREATE TRIGGER wallet_samsung_ref_keyset_immutable BEFORE UPDATE OF credential_keyset_commitment ON wallet_samsung_fetch_refs
WHEN NEW.credential_keyset_commitment IS NOT OLD.credential_keyset_commitment
BEGIN SELECT RAISE(ABORT, 'provider keyset commitment is immutable'); END;
CREATE TRIGGER wallet_samsung_tombstone_keyset_immutable BEFORE UPDATE OF credential_keyset_commitment ON wallet_samsung_tombstones
WHEN NEW.credential_keyset_commitment IS NOT OLD.credential_keyset_commitment
BEGIN SELECT RAISE(ABORT, 'provider keyset commitment is immutable'); END;

-- A provider generation is complete only after a no-artifact placeholder is closed or an
-- issued Samsung identity is definitively revoked with its durable authenticated tombstones.
-- Issued Google objects remain held until a real inactive-object replay guarantee exists.
CREATE VIEW wallet_provider_retirement_complete AS
SELECT i.id FROM wallet_provider_instances i
WHERE i.lifecycle = 'retired'
  AND EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
    AND keyset.commitment = i.credential_keyset_commitment)
  AND (
  (i.retirement_reason = 'not_issued' AND i.account_id IS NULL AND i.identity_projection_release_id IS NULL
    AND i.desired_version = 0 AND i.desired_operation_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_offer_refs o WHERE o.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs r WHERE r.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_bindings b WHERE b.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_callback_events e WHERE e.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_callback_receipts r WHERE r.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_receipts r WHERE r.instance_id = i.id))
  OR (i.provider = 'samsung' AND i.retirement_reason IS NULL AND i.retirement_requested_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM wallet_provider_accounts a WHERE a.id = i.account_id
      AND a.org_id = i.org_id AND a.mode = i.mode AND a.provider = i.provider)
    AND EXISTS (SELECT 1 FROM template_releases projection_release
      JOIN template_candidates candidate ON candidate.id = projection_release.candidate_id
      JOIN template_approvals approval ON approval.id = projection_release.approval_id AND approval.candidate_id = candidate.id
      JOIN wallet_provider_projection_evidence_history evidence ON evidence.candidate_id = candidate.id
      WHERE projection_release.id = i.identity_projection_release_id AND projection_release.org_id = i.org_id
        AND projection_release.mode = i.mode AND projection_release.provider = 'samsung' AND projection_release.source = 'approved'
        AND candidate.provider_account_id = i.account_id
        AND candidate.org_id = i.org_id AND candidate.mode = i.mode AND candidate.provider = 'samsung'
        AND projection_release.candidate_hash = candidate.candidate_hash AND approval.candidate_hash = candidate.candidate_hash
        AND approval.reviewer_id != candidate.author_id
        AND (candidate.version_author_id IS NULL OR approval.reviewer_id != candidate.version_author_id)
        AND projection_release.credential_keyset_commitment = i.credential_keyset_commitment
        AND candidate.credential_keyset_commitment = i.credential_keyset_commitment
        AND approval.credential_keyset_commitment = i.credential_keyset_commitment
        AND evidence.credential_keyset_commitment = i.credential_keyset_commitment
        AND evidence.org_id = i.org_id AND evidence.mode = i.mode AND evidence.account_id = i.account_id
        AND evidence.account_revision = candidate.provider_account_revision AND evidence.candidate_hash = candidate.candidate_hash
        AND evidence.provider_identity_hash = candidate.provider_identity_hash
        AND evidence.card_type = json_extract(candidate.projection_json, '$.cardType')
        AND evidence.card_sub_type = json_extract(candidate.projection_json, '$.cardSubType')
        AND evidence.country_code = json_extract(candidate.projection_json, '$.countryCode')
        AND evidence.testing_mode_off = 'Y' AND evidence.verified_at <= projection_release.created_at
        AND projection_release.created_at < evidence.expires_at)
    AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
      WHERE op.id = i.desired_operation_id AND op.instance_id = i.id AND op.version = i.desired_version
        AND op.kind = 'revoke' AND op.state = 'succeeded'
        AND op.credential_keyset_commitment = i.credential_keyset_commitment)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
      WHERE busy.instance_id = i.id AND busy.state IN ('pending', 'retry', 'claimed', 'uncertain'))
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref WHERE ref.instance_id = i.id
      AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones t
        JOIN template_releases r ON r.id = i.identity_projection_release_id
        JOIN template_candidates c ON c.id = r.candidate_id
        WHERE ref.credential_keyset_commitment = i.credential_keyset_commitment
          AND t.credential_keyset_commitment = i.credential_keyset_commitment
          AND t.ref_hash = ref.ref_hash AND t.org_id = i.org_id AND t.mode = i.mode
          AND t.account_id = i.account_id AND t.release_id = r.id AND t.candidate_id = c.id
          AND r.credential_keyset_commitment = i.credential_keyset_commitment
          AND c.credential_keyset_commitment = i.credential_keyset_commitment
          AND c.provider_account_id = i.account_id AND t.account_revision = c.provider_account_revision
          AND t.provider_identity_hash = c.provider_identity_hash)))
);

-- A placeholder is unissued only if no provider identity, operation or response exists.
-- This view is used inside the same write that retires or unblocks it.
CREATE VIEW wallet_provider_unissued_placeholder AS
SELECT i.id FROM wallet_provider_instances i
WHERE i.account_id IS NULL AND i.identity_projection_release_id IS NULL
  AND i.desired_version = 0 AND i.desired_operation_id IS NULL
  AND i.retired_at IS NULL AND i.revoked_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.instance_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM wallet_provider_offer_refs o WHERE o.instance_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs r WHERE r.instance_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_bindings b WHERE b.instance_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM wallet_provider_callback_events e WHERE e.instance_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM wallet_samsung_callback_receipts r WHERE r.instance_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_receipts r WHERE r.instance_id = i.id);

-- An existing issued identity may be staged only under its original, still-current proof.
CREATE VIEW wallet_provider_pinned_desired AS
SELECT i.id FROM wallet_provider_instances i
JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
  AND op.instance_id = i.id AND op.version = i.desired_version
JOIN template_releases projection_release ON projection_release.id = i.identity_projection_release_id
JOIN template_candidates candidate ON candidate.id = projection_release.candidate_id
JOIN template_approvals approval ON approval.id = projection_release.approval_id AND approval.candidate_id = candidate.id
JOIN credential_ref_keyset keyset ON keyset.id = 1 AND keyset.commitment = i.credential_keyset_commitment
WHERE op.credential_keyset_commitment = i.credential_keyset_commitment
  AND projection_release.credential_keyset_commitment = i.credential_keyset_commitment
  AND candidate.credential_keyset_commitment = i.credential_keyset_commitment
  AND approval.credential_keyset_commitment = i.credential_keyset_commitment
  AND projection_release.org_id = i.org_id AND projection_release.mode = i.mode
  AND projection_release.provider = i.provider AND projection_release.source = 'approved'
  AND candidate.org_id = i.org_id AND candidate.mode = i.mode AND candidate.provider = i.provider
  AND candidate.provider_account_id = i.account_id AND projection_release.candidate_hash = candidate.candidate_hash
  AND approval.candidate_hash = candidate.candidate_hash;

-- Publication, recipient-market eligibility and replay safety cannot currently be proven for
-- a new provider identity. Only an unbound current-generation transfer target may be
-- inserted; reviewed projections alone do not authorize issuance.
CREATE TRIGGER wallet_provider_generation_insert_guard BEFORE INSERT ON wallet_provider_instances
WHEN NEW.lifecycle != 'blocked' OR NEW.retirement_requested_at IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
    AND keyset.commitment = NEW.credential_keyset_commitment)
  OR NOT EXISTS (
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
  )
BEGIN SELECT RAISE(ABORT, 'provider issuance is unavailable'); END;

CREATE TRIGGER wallet_provider_generation_binding_guard BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle = 'ready' AND NEW.lifecycle = 'active'
BEGIN SELECT RAISE(ABORT, 'provider issuance is unavailable'); END;
CREATE TRIGGER wallet_provider_generation_no_reblock BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle = 'ready' AND NEW.lifecycle = 'blocked'
BEGIN SELECT RAISE(ABORT, 'provider generation cannot be reblocked'); END;


-- A pending target cannot be retired or marked for retirement, including by a direct write.
CREATE TRIGGER wallet_provider_pending_target_retirement BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle = 'blocked' AND NEW.lifecycle = 'retired' AND EXISTS (
  SELECT 1 FROM pass_credential_transfers t
  WHERE t.pass_id = OLD.pass_id AND t.state = 'pending'
    AND t.target_generation = OLD.credential_generation
)
BEGIN SELECT RAISE(ABORT, 'pending provider target cannot retire'); END;
CREATE TRIGGER wallet_provider_pending_target_retirement_intent
BEFORE UPDATE OF retirement_requested_at ON wallet_provider_instances
WHEN OLD.retirement_requested_at IS NULL AND NEW.retirement_requested_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM pass_credential_transfers t
  WHERE t.pass_id = OLD.pass_id AND t.state = 'pending'
    AND t.target_generation = OLD.credential_generation
)
BEGIN SELECT RAISE(ABORT, 'pending provider target cannot retire'); END;

-- Only a completed reservation may unblock the exact target generation. Retiring older
-- instances or advancing a pass generation on its own is not transfer completion.
CREATE TRIGGER wallet_provider_generation_ready_guard BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle = 'blocked' AND NEW.lifecycle = 'ready' AND NOT EXISTS (
  SELECT 1 FROM passes p JOIN pass_credential_transfers t ON t.pass_id = p.id
  JOIN wallet_provider_unissued_placeholder empty ON empty.id = OLD.id
  JOIN credential_ref_keyset keyset ON keyset.id = 1 AND keyset.commitment = OLD.credential_keyset_commitment
  WHERE p.id = OLD.pass_id AND p.org_id = OLD.org_id AND p.mode = OLD.mode
    AND p.credential_generation = OLD.credential_generation AND OLD.retirement_requested_at IS NULL
    AND t.org_id = p.org_id AND t.mode = p.mode AND t.target_generation = OLD.credential_generation
    AND t.state = 'completed'
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers pending
      WHERE pending.pass_id = p.id AND pending.state = 'pending')
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_instances previous WHERE previous.pass_id = p.id
      AND previous.credential_generation < OLD.credential_generation
      AND (previous.org_id != p.org_id OR previous.mode != p.mode
        OR NOT EXISTS (SELECT 1 FROM wallet_provider_retirement_complete done WHERE done.id = previous.id)))
)
BEGIN SELECT RAISE(ABORT, 'provider generation is blocked'); END;

-- No operation or bearer artifact may be attached to an unissued placeholder. Existing
-- provider identities may still receive revoke work after their generation is superseded.
CREATE TRIGGER wallet_provider_generation_operation_guard BEFORE INSERT ON wallet_provider_instance_operations
WHEN NOT EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id
  WHERE i.id = NEW.instance_id AND i.lifecycle IN ('active', 'revoking', 'revoked')
    AND i.account_id IS NOT NULL AND p.org_id = i.org_id AND p.mode = i.mode
    AND NEW.credential_keyset_commitment = i.credential_keyset_commitment
    AND EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
      AND keyset.commitment = NEW.credential_keyset_commitment)
    AND p.version = NEW.pass_version AND p.revision = NEW.pass_revision
    AND p.lifecycle_generation = NEW.lifecycle_generation AND p.release_id IS NEW.issuing_release_id
    AND p.credential_generation = NEW.pass_credential_generation
    AND i.credential_generation <= p.credential_generation
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id
      AND t.state = 'pending' AND t.source_generation = p.credential_generation)
    AND (NEW.kind = 'revoke' OR (i.lifecycle = 'active' AND i.retirement_requested_at IS NULL
      AND p.credential_generation = i.credential_generation
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')))
)
BEGIN SELECT RAISE(ABORT, 'provider operation is not authorized'); END;

-- A bearer wrapper or new Samsung fetch reference would create a fresh issuance path.
-- Neither provider currently supplies the required independent recipient-market proof.
CREATE TRIGGER wallet_provider_generation_offer_insert BEFORE INSERT ON wallet_provider_offer_refs
BEGIN SELECT RAISE(ABORT, 'provider offer is unavailable'); END;

CREATE TRIGGER wallet_provider_generation_offer_consume
BEFORE UPDATE OF consumed_at, delivered_at ON wallet_provider_offer_refs
WHEN (NEW.consumed_at IS NOT OLD.consumed_at AND NEW.consumed_at IS NOT NULL)
  OR (NEW.delivered_at IS NOT OLD.delivered_at AND NEW.delivered_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'provider offer is unavailable'); END;

CREATE TRIGGER wallet_provider_generation_samsung_ref BEFORE INSERT ON wallet_samsung_fetch_refs
BEGIN SELECT RAISE(ABORT, 'provider reference is unavailable'); END;

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
    AND EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
      AND keyset.commitment = NEW.credential_keyset_commitment)
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')
)
BEGIN SELECT RAISE(ABORT, 'provider binding is not authorized'); END;

CREATE TRIGGER wallet_provider_generation_callback_event BEFORE INSERT ON wallet_provider_callback_events
WHEN NOT EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = NEW.instance_id
  AND i.account_id IS NOT NULL AND i.lifecycle NOT IN ('blocked', 'ready'))
BEGIN SELECT RAISE(ABORT, 'provider placeholder has no callbacks'); END;
CREATE TRIGGER wallet_provider_generation_samsung_receipt BEFORE INSERT ON wallet_samsung_callback_receipts
WHEN NOT EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = NEW.instance_id
  AND i.account_id IS NOT NULL AND i.lifecycle NOT IN ('blocked', 'ready'))
BEGIN SELECT RAISE(ABORT, 'provider placeholder has no callbacks'); END;
CREATE TRIGGER wallet_provider_generation_google_receipt BEFORE INSERT ON wallet_google_callback_receipts
WHEN NOT EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = NEW.instance_id
  AND i.account_id IS NOT NULL AND i.lifecycle NOT IN ('blocked', 'ready'))
BEGIN SELECT RAISE(ABORT, 'provider placeholder has no callbacks'); END;

-- Artifact identity is immutable: an old reference or receipt cannot be moved to a placeholder.
CREATE TRIGGER wallet_provider_generation_offer_identity BEFORE UPDATE OF instance_id ON wallet_provider_offer_refs
WHEN NEW.instance_id IS NOT OLD.instance_id
BEGIN SELECT RAISE(ABORT, 'provider artifact identity is immutable'); END;
CREATE TRIGGER wallet_provider_generation_samsung_ref_identity BEFORE UPDATE OF id, instance_id, ref_hash ON wallet_samsung_fetch_refs
WHEN NEW.id IS NOT OLD.id OR NEW.instance_id IS NOT OLD.instance_id OR NEW.ref_hash IS NOT OLD.ref_hash
BEGIN SELECT RAISE(ABORT, 'provider artifact identity is immutable'); END;
CREATE TRIGGER wallet_provider_generation_google_binding_identity BEFORE UPDATE OF instance_id ON wallet_google_callback_bindings
WHEN NEW.instance_id IS NOT OLD.instance_id
BEGIN SELECT RAISE(ABORT, 'provider artifact identity is immutable'); END;
CREATE TRIGGER wallet_provider_generation_event_identity BEFORE UPDATE OF instance_id ON wallet_provider_callback_events
WHEN NEW.instance_id IS NOT OLD.instance_id
BEGIN SELECT RAISE(ABORT, 'provider artifact identity is immutable'); END;
CREATE TRIGGER wallet_provider_generation_samsung_receipt_identity BEFORE UPDATE OF instance_id ON wallet_samsung_callback_receipts
WHEN NEW.instance_id IS NOT OLD.instance_id
BEGIN SELECT RAISE(ABORT, 'provider artifact identity is immutable'); END;
CREATE TRIGGER wallet_provider_generation_google_receipt_identity BEFORE UPDATE OF instance_id ON wallet_google_callback_receipts
WHEN NEW.instance_id IS NOT OLD.instance_id
BEGIN SELECT RAISE(ABORT, 'provider artifact identity is immutable'); END;

-- Retirement evidence is required at the actual deletion boundary, not only when a
-- candidate pass is selected for purge. REPLACE can bypass DELETE triggers in SQLite.
CREATE TRIGGER wallet_provider_instance_delete_settled BEFORE DELETE ON wallet_provider_instances
WHEN NOT EXISTS (SELECT 1 FROM wallet_provider_retirement_complete done WHERE done.id = OLD.id)
  OR EXISTS (SELECT 1 FROM passes p WHERE p.id = OLD.pass_id
    AND (p.org_id != OLD.org_id OR p.mode != OLD.mode))
BEGIN SELECT RAISE(ABORT, 'provider retirement incomplete'); END;

CREATE TRIGGER wallet_provider_instance_no_replace BEFORE INSERT ON wallet_provider_instances
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances existing WHERE existing.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'provider instance identity is immutable'); END;

-- Operation history cannot be erased to turn an unsettled retirement into a settled one.
-- Cascading deletion after the parent instance has been removed remains permitted.
CREATE TRIGGER wallet_provider_operation_history_delete BEFORE DELETE ON wallet_provider_instance_operations
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = OLD.instance_id)
BEGIN SELECT RAISE(ABORT, 'provider operation history is retained'); END;

-- REPLACE bypasses DELETE triggers; none of an operation's unique keys may evict history.
CREATE TRIGGER wallet_provider_operation_no_replace BEFORE INSERT ON wallet_provider_instance_operations
WHEN EXISTS (SELECT 1 FROM wallet_provider_instance_operations old
  WHERE old.id = NEW.id OR (old.instance_id = NEW.instance_id
    AND (old.version = NEW.version OR old.request_hash = NEW.request_hash
      OR (NEW.state IN ('claimed', 'uncertain') AND old.state IN ('claimed', 'uncertain')))))
BEGIN SELECT RAISE(ABORT, 'provider operation history is immutable'); END;
CREATE TRIGGER wallet_provider_operation_id_immutable BEFORE UPDATE OF id ON wallet_provider_instance_operations
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, 'provider operation history is immutable'); END;
CREATE TRIGGER wallet_provider_operation_inflight_no_replace
BEFORE UPDATE OF state ON wallet_provider_instance_operations
WHEN NEW.state IN ('claimed', 'uncertain') AND EXISTS (
  SELECT 1 FROM wallet_provider_instance_operations other -- not "old": that alias shadowed OLD
  WHERE other.instance_id = NEW.instance_id AND other.id != OLD.id AND other.state IN ('claimed', 'uncertain'))
BEGIN SELECT RAISE(ABORT, 'provider operation history is immutable'); END;

-- Fetch references are required to prove that every historical Samsung URL has a tombstone.
CREATE TRIGGER wallet_provider_samsung_ref_history_delete BEFORE DELETE ON wallet_samsung_fetch_refs
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = OLD.instance_id)
BEGIN SELECT RAISE(ABORT, 'Samsung reference history is retained'); END;
CREATE TRIGGER wallet_provider_samsung_ref_retirement_immutable BEFORE UPDATE OF retired_at ON wallet_samsung_fetch_refs
WHEN OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at
BEGIN SELECT RAISE(ABORT, 'Samsung reference retirement is immutable'); END;

CREATE TRIGGER wallet_provider_pass_delete_settled BEFORE DELETE ON passes
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.pass_id = OLD.id
  AND (i.org_id != OLD.org_id OR i.mode != OLD.mode
    OR NOT EXISTS (SELECT 1 FROM wallet_provider_retirement_complete done WHERE done.id = i.id)))
BEGIN SELECT RAISE(ABORT, 'provider retirement incomplete'); END;


-- A reservation alone has no provider side effects. Only its successful pass CAS stages
-- target placeholders and durable retirement work in the same transaction.
CREATE TRIGGER wallet_provider_generation_advance AFTER UPDATE OF credential_generation ON passes
WHEN NEW.credential_generation > OLD.credential_generation
BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
    OR NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
      WHERE t.pass_id = NEW.id AND t.org_id = NEW.org_id AND t.mode = NEW.mode AND t.state = 'pending'
        AND t.source_generation = OLD.credential_generation AND t.target_generation = NEW.credential_generation
        AND t.source_version = OLD.version AND t.source_revision = OLD.revision
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


-- The transfer cannot finish unless both pristine target placeholders remain reserved and
-- every older identity has terminal, replay-safe retirement evidence.
CREATE TRIGGER wallet_provider_transfer_complete_guard BEFORE UPDATE OF state ON pass_credential_transfers
WHEN OLD.state = 'pending' AND NEW.state = 'completed' AND (
  NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = OLD.pass_id AND p.org_id = OLD.org_id AND p.mode = OLD.mode
    AND p.credential_generation = OLD.target_generation)
  OR (SELECT COUNT(*) FROM wallet_provider_instances i
    JOIN wallet_provider_unissued_placeholder empty ON empty.id = i.id
    JOIN credential_ref_keyset keyset ON keyset.id = 1 AND keyset.commitment = i.credential_keyset_commitment
    WHERE i.pass_id = OLD.pass_id AND i.org_id = OLD.org_id AND i.mode = OLD.mode
      AND i.credential_generation = OLD.target_generation AND i.lifecycle = 'blocked'
      AND i.retirement_requested_at IS NULL AND i.provider IN ('google', 'samsung')) != 2
  OR EXISTS (SELECT 1 FROM wallet_provider_instances previous WHERE previous.pass_id = OLD.pass_id
    AND previous.credential_generation < OLD.target_generation
    AND (previous.org_id != OLD.org_id OR previous.mode != OLD.mode
      OR NOT EXISTS (SELECT 1 FROM wallet_provider_retirement_complete done WHERE done.id = previous.id)))
)
BEGIN SELECT RAISE(ABORT, 'provider retirement incomplete'); END;

CREATE TRIGGER wallet_provider_transfer_completed AFTER UPDATE OF state ON pass_credential_transfers
WHEN OLD.state = 'pending' AND NEW.state = 'completed'
BEGIN
  UPDATE wallet_provider_instances SET lifecycle = 'ready', updated_at = MAX(NEW.completed_at, updated_at)
    WHERE pass_id = NEW.pass_id AND org_id = NEW.org_id AND mode = NEW.mode
      AND credential_generation = NEW.target_generation AND lifecycle = 'blocked';
END;

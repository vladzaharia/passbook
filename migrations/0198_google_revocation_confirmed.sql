-- CW9b: a Google object retires once its revocation is confirmed (architecture 6.2, G5).
-- The revoke PUTs the object inactive and without a barcode, then GETs it back. A replayed save JWT can
-- then only add an inactive, barcode-less object, so the confirmation is the replay boundary 0037 and
-- 0114 refused to retire without. The confirmation is written in the same fenced batch that completes the
-- revoke, and settles the instance through the retirement view.

-- The class a typed object belongs to depends on its type and class key, which the callback must
-- re-derive. NULL means the original derivation (Generic, one class per release).
ALTER TABLE wallet_google_callback_bindings ADD COLUMN class_type TEXT
  CHECK(class_type IS NULL OR class_type IN ('generic', 'event', 'loyalty', 'gift', 'offer'));
ALTER TABLE wallet_google_callback_bindings ADD COLUMN class_key TEXT
  CHECK(class_key IS NULL OR (length(class_key) = 64 AND class_key NOT GLOB '*[^0-9a-f]*'));

CREATE TABLE wallet_google_revocation_confirmations (
  operation_id TEXT PRIMARY KEY REFERENCES wallet_provider_instance_operations(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  confirmed_at INTEGER NOT NULL,
  credential_keyset_commitment TEXT NOT NULL
  CHECK(length(credential_keyset_commitment) = 64 AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX wallet_google_revocation_confirmations_instance ON wallet_google_revocation_confirmations(instance_id);
CREATE TRIGGER wallet_google_revocation_confirmations_insert BEFORE INSERT ON wallet_google_revocation_confirmations
WHEN NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
  JOIN wallet_provider_instances i ON i.id = op.instance_id
  WHERE op.id = NEW.operation_id AND op.instance_id = NEW.instance_id AND op.version = NEW.version
    AND op.kind = 'revoke' AND op.state IN ('claimed', 'uncertain') AND i.provider = 'google'
    AND op.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND i.credential_keyset_commitment = NEW.credential_keyset_commitment)
BEGIN SELECT RAISE(ABORT, 'google revocation confirmation needs a claimed revoke'); END;
CREATE TRIGGER wallet_google_revocation_confirmations_immutable BEFORE UPDATE ON wallet_google_revocation_confirmations
BEGIN SELECT RAISE(ABORT, 'google revocation confirmation is immutable'); END;

-- The Google branch of the retirement evidence, in its own view so no expression gets deeper.
CREATE VIEW wallet_google_retirement_complete AS
SELECT i.id FROM wallet_provider_instances i
WHERE i.lifecycle = 'retired' AND i.provider = 'google' AND i.retirement_reason IS NULL
  AND i.retirement_requested_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
    AND keyset.commitment = i.credential_keyset_commitment)
  AND EXISTS (SELECT 1 FROM wallet_provider_accounts a WHERE a.id = i.account_id
    AND a.org_id = i.org_id AND a.mode = i.mode AND a.provider = i.provider)
  AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
    JOIN wallet_google_revocation_confirmations confirmed ON confirmed.operation_id = op.id
    WHERE op.id = i.desired_operation_id AND op.instance_id = i.id AND op.version = i.desired_version
      AND op.kind = 'revoke' AND op.state = 'succeeded'
      AND op.credential_keyset_commitment = i.credential_keyset_commitment
      AND confirmed.instance_id = i.id AND confirmed.version = op.version
      AND confirmed.credential_keyset_commitment = i.credential_keyset_commitment)
  AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
    WHERE busy.instance_id = i.id AND busy.state IN ('pending', 'retry', 'claimed', 'uncertain'));

-- 0050's view, unchanged, under a new name.
CREATE VIEW wallet_provider_retirement_complete_base AS
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
      WHERE (
        projection_release.id = i.identity_projection_release_id AND projection_release.org_id = i.org_id
        AND projection_release.mode = i.mode AND projection_release.provider = 'samsung' AND projection_release.source = 'approved'
        AND candidate.provider_account_id = i.account_id
        AND candidate.org_id = i.org_id AND candidate.mode = i.mode AND candidate.provider = 'samsung'
      ) AND (
        projection_release.candidate_hash = candidate.candidate_hash AND approval.candidate_hash = candidate.candidate_hash
        AND approval.reviewer_id != candidate.author_id
        AND (candidate.version_author_id IS NULL OR approval.reviewer_id != candidate.version_author_id)
        AND projection_release.credential_keyset_commitment = i.credential_keyset_commitment
        AND candidate.credential_keyset_commitment = i.credential_keyset_commitment
        AND approval.credential_keyset_commitment = i.credential_keyset_commitment
        AND evidence.credential_keyset_commitment = i.credential_keyset_commitment
      ) AND (
        evidence.org_id = i.org_id AND evidence.mode = i.mode AND evidence.account_id = i.account_id
        AND evidence.account_revision = candidate.provider_account_revision AND evidence.candidate_hash = candidate.candidate_hash
        AND evidence.provider_identity_hash = candidate.provider_identity_hash
        AND evidence.card_type = json_extract(candidate.projection_json, '$.cardType')
        AND evidence.card_sub_type = json_extract(candidate.projection_json, '$.cardSubType')
        AND evidence.country_code = json_extract(candidate.projection_json, '$.countryCode')
        AND evidence.testing_mode_off = 'Y' AND evidence.verified_at <= projection_release.created_at
        AND projection_release.created_at < evidence.expires_at
      ))
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
        WHERE (
          ref.credential_keyset_commitment = i.credential_keyset_commitment
          AND t.credential_keyset_commitment = i.credential_keyset_commitment
          AND t.ref_hash = ref.ref_hash AND t.org_id = i.org_id AND t.mode = i.mode
          AND t.account_id = i.account_id AND t.release_id = r.id AND t.candidate_id = c.id
        ) AND (
          r.credential_keyset_commitment = i.credential_keyset_commitment
          AND c.credential_keyset_commitment = i.credential_keyset_commitment
          AND c.provider_account_id = i.account_id AND t.account_revision = c.provider_account_revision
          AND t.provider_identity_hash = c.provider_identity_hash
        )
      )
    )
  )
);

DROP VIEW wallet_provider_retirement_complete;
CREATE VIEW wallet_provider_retirement_complete AS
SELECT id FROM wallet_provider_retirement_complete_base
UNION ALL
SELECT id FROM wallet_google_retirement_complete;

-- 0037 and 0114 refused to retire (and so to delete) an issued Google object outright. It may now, once the
-- revocation is confirmed; the settled-retirement guards of 0148 still decide the delete.
DROP TRIGGER wallet_provider_instances_no_delete;
CREATE TRIGGER wallet_provider_instances_no_delete BEFORE DELETE ON wallet_provider_instances
WHEN OLD.lifecycle != 'retired'
BEGIN SELECT RAISE(ABORT, 'provider instance retirement required'); END;
-- BEFORE triggers fire newest first: recreate 0148's settled-retirement guard unchanged, so it still answers first.
DROP TRIGGER wallet_provider_instance_delete_settled;
CREATE TRIGGER wallet_provider_instance_delete_settled BEFORE DELETE ON wallet_provider_instances
WHEN OLD.retirement_settled_at IS NULL
  OR EXISTS (SELECT 1 FROM passes p WHERE p.id = OLD.pass_id
    AND (p.org_id != OLD.org_id OR p.mode != OLD.mode))
BEGIN SELECT RAISE(ABORT, 'provider retirement incomplete'); END;

DROP TRIGGER wallet_provider_instances_lifecycle_forward;
CREATE TRIGGER wallet_provider_instances_lifecycle_forward BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN (OLD.lifecycle = 'retired' AND NEW.lifecycle != 'retired')
  OR (OLD.lifecycle = 'blocked' AND NEW.lifecycle NOT IN ('blocked', 'ready', 'retired'))
  OR (OLD.lifecycle = 'ready' AND NEW.lifecycle NOT IN ('blocked', 'ready', 'active', 'retired'))
  OR (OLD.lifecycle = 'active' AND NEW.lifecycle NOT IN ('active', 'revoking'))
  OR (OLD.lifecycle = 'ready' AND NEW.lifecycle = 'blocked' AND (
    OLD.account_id IS NOT NULL OR OLD.identity_projection_release_id IS NOT NULL
    OR OLD.desired_operation_id IS NOT NULL OR OLD.desired_version != 0
    OR EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.instance_id = OLD.id)
    OR EXISTS (SELECT 1 FROM wallet_provider_offer_refs offer WHERE offer.instance_id = OLD.id)
    OR EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref WHERE ref.instance_id = OLD.id)
    OR EXISTS (SELECT 1 FROM wallet_google_callback_bindings binding WHERE binding.instance_id = OLD.id)
    OR EXISTS (SELECT 1 FROM wallet_provider_callback_events event WHERE event.instance_id = OLD.id)
    OR EXISTS (SELECT 1 FROM wallet_samsung_callback_receipts receipt WHERE receipt.instance_id = OLD.id)
    OR EXISTS (SELECT 1 FROM wallet_google_callback_receipts receipt WHERE receipt.instance_id = OLD.id)
  ))
  OR (OLD.lifecycle = 'blocked' AND NEW.lifecycle = 'ready' AND EXISTS (
    SELECT 1 FROM wallet_provider_instances predecessor WHERE predecessor.pass_id = OLD.pass_id
      AND predecessor.provider = OLD.provider AND predecessor.id != OLD.id
      AND predecessor.lifecycle NOT IN ('blocked', 'retired')
  ))
  OR (NEW.lifecycle = 'retired' AND OLD.lifecycle IN ('blocked', 'ready') AND (
    NEW.retirement_reason IS NOT 'not_issued' OR NEW.account_id IS NOT NULL
    OR NEW.identity_projection_release_id IS NOT NULL OR NEW.desired_operation_id IS NOT NULL
    OR NEW.desired_version != 0 OR NEW.retired_at IS NULL
    OR EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.instance_id = OLD.id)
    OR EXISTS (SELECT 1 FROM wallet_provider_offer_refs offer WHERE offer.instance_id = OLD.id)
    OR EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref WHERE ref.instance_id = OLD.id)
    OR EXISTS (SELECT 1 FROM wallet_google_callback_bindings binding WHERE binding.instance_id = OLD.id)
    OR EXISTS (SELECT 1 FROM wallet_provider_callback_events event WHERE event.instance_id = OLD.id)
    OR EXISTS (SELECT 1 FROM wallet_samsung_callback_receipts receipt WHERE receipt.instance_id = OLD.id)
    OR EXISTS (SELECT 1 FROM wallet_google_callback_receipts receipt WHERE receipt.instance_id = OLD.id)
  ))
  OR (NEW.lifecycle = 'retired' AND OLD.provider = 'google' AND OLD.desired_version > 0 AND NOT EXISTS (
    SELECT 1 FROM wallet_google_revocation_confirmations confirmed
    WHERE confirmed.operation_id = OLD.desired_operation_id AND confirmed.instance_id = OLD.id
      AND confirmed.version = OLD.desired_version
      AND confirmed.credential_keyset_commitment = OLD.credential_keyset_commitment))
  OR (NEW.lifecycle = 'retired' AND OLD.lifecycle NOT IN ('retired', 'blocked', 'ready') AND
    (OLD.lifecycle != 'revoked' OR OLD.retirement_requested_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM wallet_provider_instance_operations op
      WHERE op.id = OLD.desired_operation_id AND op.instance_id = OLD.id
        AND op.kind = 'revoke' AND op.state = 'succeeded'
        AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
          WHERE busy.instance_id = OLD.id AND busy.state IN ('claimed', 'uncertain'))
        AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref
          WHERE ref.instance_id = OLD.id AND NOT EXISTS (
            SELECT 1 FROM wallet_samsung_tombstones t WHERE t.ref_hash = ref.ref_hash
              AND t.org_id = OLD.org_id AND t.mode = OLD.mode AND t.account_id = OLD.account_id
              AND t.release_id = OLD.identity_projection_release_id
              AND EXISTS (SELECT 1 FROM template_releases ir
                JOIN template_candidates ic ON ic.id = ir.candidate_id
                WHERE ir.id = OLD.identity_projection_release_id AND t.candidate_id = ic.id
                  AND t.account_revision = ic.provider_account_revision
                  AND t.provider_identity_hash = ic.provider_identity_hash)
          ))
    )))
  OR (OLD.lifecycle IN ('revoking', 'revoked') AND NEW.lifecycle = 'active' AND NOT EXISTS (
    SELECT 1 FROM wallet_provider_instance_operations op JOIN passes p ON p.id = OLD.pass_id
    WHERE OLD.retirement_requested_at IS NULL AND op.id = OLD.desired_operation_id AND op.kind = 'revoke'
      AND op.state IN ('pending', 'retry', 'failed', 'superseded', 'succeeded')
      AND p.org_id = OLD.org_id AND p.mode = OLD.mode AND p.status = 'active'
      AND p.deleted_at IS NULL AND p.removed_at IS NULL AND p.test_data_quarantined = 0
      AND p.lifecycle_generation > op.lifecycle_generation
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
        WHERE busy.instance_id = OLD.id AND busy.state IN ('claimed', 'uncertain'))
  ))
  OR (OLD.lifecycle = 'revoking' AND NEW.lifecycle NOT IN ('revoking', 'revoked', 'active'))
  OR (OLD.lifecycle = 'revoked' AND NEW.lifecycle NOT IN ('revoked', 'retired', 'active'))
BEGIN SELECT RAISE(ABORT, 'provider lifecycle cannot be reversed'); END;

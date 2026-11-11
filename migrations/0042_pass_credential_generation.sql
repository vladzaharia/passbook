-- Credential authority is independent of public-link rotation and removal/restore history.
ALTER TABLE passes ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(credential_generation) = 'integer'
    AND credential_generation BETWEEN 1 AND 9007199254740991);

-- Existing registrations belong to the original credential incarnation.
ALTER TABLE registrations ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(credential_generation) = 'integer'
    AND credential_generation BETWEEN 1 AND 9007199254740991);

CREATE TABLE pass_credential_transfers (
  id TEXT NOT NULL PRIMARY KEY,
  pass_id TEXT NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  source_generation INTEGER NOT NULL CHECK (typeof(source_generation) = 'integer'
    AND source_generation BETWEEN 1 AND 9007199254740990),
  target_generation INTEGER GENERATED ALWAYS AS (source_generation + 1) STORED,
  source_version INTEGER NOT NULL CHECK (typeof(source_version) = 'integer' AND source_version > 0),
  source_revision INTEGER NOT NULL CHECK (typeof(source_revision) = 'integer' AND source_revision >= 0),
  -- Staleness of the source read (authority-epochs.md section 1.1). version and revision are recorded for
  -- the audit trail and the provider-track fences; the guards below compare row_version instead.
  source_row_version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(source_row_version) = 'integer' AND source_row_version > 0),
  source_lifecycle_generation INTEGER NOT NULL CHECK (typeof(source_lifecycle_generation) = 'integer' AND source_lifecycle_generation >= 0),
  source_link_generation INTEGER NOT NULL CHECK (typeof(source_link_generation) = 'integer' AND source_link_generation > 0),
  -- Connector authority and the admitted release are captured rather than reconstructed on retry.
  source_connection_id TEXT,
  source_connection_ref TEXT,
  source_connection_generation INTEGER,
  source_connection_mode TEXT,
  source_admitted_release_id TEXT,
  source_admitted_release_generation INTEGER,
  source_admitted_release_version TEXT,
  target_holder_email TEXT,
  target_owner_user_id TEXT,
  requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('user', 'api_key', 'system', 'connection', 'scanner')),
  requested_by_id TEXT,
  requested_at INTEGER NOT NULL CHECK (typeof(requested_at) = 'integer' AND requested_at >= 0),
  completed_at INTEGER,
  CHECK ((state = 'pending' AND completed_at IS NULL)
    OR (state = 'completed' AND typeof(completed_at) = 'integer' AND completed_at >= requested_at)),
  CHECK (
    (source_connection_id IS NULL AND source_connection_ref IS NULL
      AND source_connection_generation IS NULL AND source_connection_mode IS NULL
      AND source_admitted_release_id IS NULL AND source_admitted_release_generation IS NULL
      AND source_admitted_release_version IS NULL)
    OR (source_connection_id IS NOT NULL AND length(source_connection_id) > 0
      AND typeof(source_connection_generation) = 'integer' AND source_connection_generation > 0
      AND source_connection_mode IS NOT NULL
      AND source_connection_mode IN ('poll', 'webhook', 'hybrid', 'manual', 'snapshot')
      AND source_admitted_release_id IS NOT NULL AND length(source_admitted_release_id) > 0
      AND typeof(source_admitted_release_generation) = 'integer' AND source_admitted_release_generation > 0
      AND source_admitted_release_version IS NOT NULL AND length(source_admitted_release_version) > 0)
  ),
  UNIQUE (pass_id, target_generation)
);
CREATE UNIQUE INDEX pass_credential_transfers_one_pending
  ON pass_credential_transfers(pass_id) WHERE state = 'pending';
CREATE INDEX pass_credential_transfers_org ON pass_credential_transfers(org_id);
CREATE INDEX pass_credential_transfers_pending_due
  ON pass_credential_transfers(state, requested_at, id);

-- Connector-supplied personalization and field sources remain encrypted until finalization.
CREATE TABLE pass_credential_transfer_payloads (
  transfer_id TEXT NOT NULL PRIMARY KEY REFERENCES pass_credential_transfers(id) ON DELETE CASCADE,
  kek_version INTEGER NOT NULL CHECK (typeof(kek_version) = 'integer' AND kek_version > 0),
  iv BLOB NOT NULL CHECK (typeof(iv) = 'blob' AND length(iv) = 12),
  wrapped_dek BLOB NOT NULL CHECK (typeof(wrapped_dek) = 'blob' AND length(wrapped_dek) = 60),
  ciphertext BLOB NOT NULL CHECK (typeof(ciphertext) = 'blob' AND length(ciphertext) >= 16)
);
CREATE TRIGGER pass_credential_transfer_payload_insert_guard
BEFORE INSERT ON pass_credential_transfer_payloads
WHEN EXISTS (SELECT 1 FROM pass_credential_transfer_payloads p WHERE p.transfer_id = NEW.transfer_id)
  OR NOT EXISTS (SELECT 1 FROM pass_credential_transfers t JOIN passes p ON p.id = t.pass_id
    WHERE t.id = NEW.transfer_id AND t.state = 'pending' AND t.source_connection_id IS NOT NULL
      AND p.org_id = t.org_id AND p.mode = t.mode AND p.credential_generation = t.target_generation
      AND p.lifecycle_generation = t.source_lifecycle_generation AND p.link_generation = t.source_link_generation)
BEGIN SELECT RAISE(ABORT, 'invalid credential transfer payload'); END;
CREATE TRIGGER pass_credential_transfer_payload_no_update BEFORE UPDATE ON pass_credential_transfer_payloads
BEGIN SELECT RAISE(ABORT, 'credential transfer payload is immutable'); END;
CREATE TRIGGER pass_credential_transfer_payload_no_delete BEFORE DELETE ON pass_credential_transfer_payloads
WHEN EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.id = OLD.transfer_id AND t.state = 'pending')
BEGIN SELECT RAISE(ABORT, 'credential transfer payload is immutable'); END;

-- A pending reservation is inserted before the generation/link UPDATE in the same D1 batch.
-- Its source link is the expected post-rotation value; all other snapshot fields are current.
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
      AND template.status = 'active'
      AND rel.template_id = p.template_id AND rel.mode = p.mode AND rel.provider = 'apple'
      AND rel.generation = NEW.source_admitted_release_generation
      AND rel.version = NEW.source_admitted_release_version
      AND (rel.org_id = p.org_id OR (rel.org_id IS NULL
        AND template.org_id IS NULL AND template.origin = 'baked'))
      AND NOT EXISTS (SELECT 1 FROM template_releases newer WHERE newer.template_id = rel.template_id
        AND newer.org_id IS rel.org_id AND newer.mode = rel.mode AND newer.provider = rel.provider
        AND newer.generation > rel.generation)
  ))
BEGIN SELECT RAISE(ABORT, 'invalid credential transfer snapshot'); END;

-- Even direct writes cannot cancel, retarget, replace or reopen a transfer. The completion
-- check repeats the pass incarnation and requires every older provider identity to be settled.
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
        AND template.status = 'active' AND p.template_version = rel.version
        AND rel.template_id = p.template_id AND rel.mode = p.mode AND rel.provider = 'apple'
        AND (rel.org_id = p.org_id OR (rel.org_id IS NULL
          AND template.org_id IS NULL AND template.origin = 'baked'))
        AND EXISTS (SELECT 1 FROM template_release_heads head WHERE head.release_id = rel.id)
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

-- History is retained for a live pass; deleting the parent may cascade completed history only.
CREATE TRIGGER pass_credential_transfer_no_delete
BEFORE DELETE ON pass_credential_transfers
WHEN EXISTS (SELECT 1 FROM passes p WHERE p.id = OLD.pass_id)
BEGIN SELECT RAISE(ABORT, 'credential transfer history is immutable'); END;
CREATE TRIGGER pass_credential_transfer_pending_no_pass_delete
BEFORE DELETE ON passes
WHEN EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = OLD.id AND t.state = 'pending')
BEGIN SELECT RAISE(ABORT, 'pending credential transfer cannot be deleted'); END;
-- SQLite REPLACE can bypass DELETE triggers and silently erase an existing pass, resetting
-- its generation. Reject collisions explicitly on both INSERT and UPDATE, even for passes
-- without provider instances or a pending transfer. Preserve normal uniqueness error details.
CREATE TRIGGER pass_credential_no_replace_insert BEFORE INSERT ON passes
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.id') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM passes p WHERE p.download_token = NEW.download_token)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.download_token') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM passes p WHERE p.identity_id = NEW.identity_id AND p.serial = NEW.serial)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.identity_id, passes.serial') END;
  SELECT CASE WHEN NEW.scan_code IS NOT NULL AND EXISTS (SELECT 1 FROM passes p WHERE p.scan_code = NEW.scan_code)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.scan_code') END;
  SELECT CASE WHEN NEW.connection_id IS NOT NULL AND NEW.external_ref IS NOT NULL
    AND EXISTS (SELECT 1 FROM passes p WHERE p.org_id = NEW.org_id AND p.connection_id = NEW.connection_id
      AND p.external_ref = NEW.external_ref)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.org_id, passes.connection_id, passes.external_ref') END;
END;

CREATE TRIGGER pass_credential_no_replace_update
BEFORE UPDATE OF id, download_token, identity_id, serial, scan_code, org_id, connection_id, external_ref ON passes
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM passes p WHERE p.id IS NOT OLD.id AND p.id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.id') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM passes p WHERE p.id IS NOT OLD.id AND p.download_token = NEW.download_token)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.download_token') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM passes p WHERE p.id IS NOT OLD.id
    AND p.identity_id = NEW.identity_id AND p.serial = NEW.serial)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.identity_id, passes.serial') END;
  SELECT CASE WHEN NEW.scan_code IS NOT NULL
    AND EXISTS (SELECT 1 FROM passes p WHERE p.id IS NOT OLD.id AND p.scan_code = NEW.scan_code)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.scan_code') END;
  SELECT CASE WHEN NEW.connection_id IS NOT NULL AND NEW.external_ref IS NOT NULL
    AND EXISTS (SELECT 1 FROM passes p WHERE p.id IS NOT OLD.id AND p.org_id = NEW.org_id
      AND p.connection_id = NEW.connection_id AND p.external_ref = NEW.external_ref)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.org_id, passes.connection_id, passes.external_ref') END;
END;

-- No generation change may commit without a matching durable pending reservation. START
-- advances exactly once while rotating the public capability in that same guarded UPDATE.
CREATE TRIGGER pass_credential_generation_reserved
BEFORE UPDATE OF credential_generation ON passes
WHEN NEW.credential_generation IS NOT OLD.credential_generation AND NOT EXISTS (
  SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = OLD.id AND t.state = 'pending'
    AND t.org_id = OLD.org_id AND t.mode = OLD.mode
    AND OLD.credential_generation = t.source_generation AND NEW.credential_generation = t.target_generation
    AND NEW.credential_generation = OLD.credential_generation + 1
    AND OLD.row_version = t.source_row_version
    AND OLD.lifecycle_generation = t.source_lifecycle_generation
    AND OLD.link_generation + 1 = t.source_link_generation AND NEW.link_generation = t.source_link_generation
    AND NEW.download_token IS NOT OLD.download_token
)
BEGIN SELECT RAISE(ABORT, 'credential generation requires a pending reservation'); END;

-- Preserve 0030's removal proof: publishing a removal changes status while removed_at is
-- already set and must not advance its claimed lifecycle generation a second time. Other
-- status, deletion, quarantine and removal transitions invalidate stale scanner authority.
-- pass_published (0045) repeats this WHEN to snapshot the post-bump generation into its push.
CREATE TRIGGER pass_lifecycle_authority_changed
AFTER UPDATE OF status, deleted_at, test_data_quarantined, removed_at ON passes
WHEN NEW.lifecycle_generation = OLD.lifecycle_generation
  AND (NEW.deleted_at IS NOT OLD.deleted_at
    OR NEW.test_data_quarantined IS NOT OLD.test_data_quarantined
    OR NEW.removed_at IS NOT OLD.removed_at
    OR (NEW.status IS NOT OLD.status AND NEW.removed_at IS NULL))
BEGIN
  UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = NEW.id;
END;

-- A queued refresh belongs to the authority that requested it, not a later incarnation or
-- lifecycle. Clearing its coalescing marker lets the later snapshot enqueue its own work.
CREATE TRIGGER pass_authority_refresh_reset
AFTER UPDATE OF credential_generation, lifecycle_generation ON passes
WHEN (NEW.credential_generation IS NOT OLD.credential_generation
    OR NEW.lifecycle_generation IS NOT OLD.lifecycle_generation)
  AND NEW.refresh_requested_at IS NOT NULL
BEGIN
  UPDATE passes SET refresh_requested_at = NULL WHERE id = NEW.id;
END;

-- While pending, only START may advance its reserved generation/link and only the one final
-- artifact commit may replace credentials and version under the already-reserved generation.
CREATE TRIGGER pass_credential_transfer_pending_pass_guard
BEFORE UPDATE OF id, org_id, mode, credential_generation, lifecycle_generation, link_generation,
  status, removed_at, deleted_at, test_data_quarantined, download_token,
  template_id, template_version, release_id, connection_id, external_ref, web_service_url,
  holder_email, owner_user_id, identity_id, serial, auth_token, scan_code, barcode_hash, lookup_hash,
  personalization, field_sources, display_title, display_subtitle, version, object_key, object_sha256,
  object_size, content_hash, modified_at, modified_collision, removal_message, removal_prior_status,
  removal_published_generation, removal_claim_version, removal_claim_status, removal_claim_object_key,
  removal_claim_link_generation ON passes
WHEN EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = OLD.id AND t.state = 'pending'
  AND (
    NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
    OR NEW.lifecycle_generation IS NOT OLD.lifecycle_generation
    OR NEW.status IS NOT OLD.status OR NEW.removed_at IS NOT OLD.removed_at
    OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.test_data_quarantined IS NOT OLD.test_data_quarantined
    OR NEW.template_id IS NOT OLD.template_id OR NEW.connection_id IS NOT OLD.connection_id
    OR NEW.external_ref IS NOT OLD.external_ref OR NEW.web_service_url IS NOT OLD.web_service_url
    OR NEW.removal_message IS NOT OLD.removal_message OR NEW.removal_prior_status IS NOT OLD.removal_prior_status
    OR NEW.removal_claim_version IS NOT OLD.removal_claim_version
    OR NEW.removal_claim_status IS NOT OLD.removal_claim_status
    OR NEW.removal_claim_object_key IS NOT OLD.removal_claim_object_key
    OR NEW.removal_claim_link_generation IS NOT OLD.removal_claim_link_generation
    OR ((NEW.credential_generation IS NOT OLD.credential_generation
      OR NEW.link_generation IS NOT OLD.link_generation OR NEW.download_token IS NOT OLD.download_token)
      AND NOT (OLD.credential_generation = t.source_generation AND NEW.credential_generation = t.target_generation
        AND OLD.row_version = t.source_row_version
        AND OLD.lifecycle_generation = t.source_lifecycle_generation
        AND OLD.link_generation + 1 = t.source_link_generation AND NEW.link_generation = t.source_link_generation
        AND NEW.download_token IS NOT OLD.download_token))
    OR ((NEW.holder_email IS NOT OLD.holder_email OR NEW.owner_user_id IS NOT OLD.owner_user_id
      OR NEW.identity_id IS NOT OLD.identity_id OR NEW.serial IS NOT OLD.serial
      OR NEW.auth_token IS NOT OLD.auth_token OR NEW.scan_code IS NOT OLD.scan_code
      OR NEW.barcode_hash IS NOT OLD.barcode_hash OR NEW.lookup_hash IS NOT OLD.lookup_hash
      OR NEW.template_version IS NOT OLD.template_version OR NEW.release_id IS NOT OLD.release_id
      OR NEW.personalization IS NOT OLD.personalization OR NEW.field_sources IS NOT OLD.field_sources
      OR NEW.display_title IS NOT OLD.display_title OR NEW.display_subtitle IS NOT OLD.display_subtitle
      OR NEW.version IS NOT OLD.version OR NEW.object_key IS NOT OLD.object_key
      OR NEW.object_sha256 IS NOT OLD.object_sha256 OR NEW.object_size IS NOT OLD.object_size
      OR NEW.content_hash IS NOT OLD.content_hash OR NEW.modified_at IS NOT OLD.modified_at
      OR NEW.modified_collision IS NOT OLD.modified_collision
      OR NEW.removal_published_generation IS NOT OLD.removal_published_generation)
      AND NOT (OLD.credential_generation = t.target_generation
        AND OLD.lifecycle_generation = t.source_lifecycle_generation
        AND OLD.link_generation = t.source_link_generation AND NEW.version = OLD.version + 1
        AND NEW.holder_email IS t.target_holder_email AND NEW.owner_user_id IS t.target_owner_user_id
        AND NEW.serial IS NOT OLD.serial AND NEW.auth_token IS NOT OLD.auth_token
        AND NEW.scan_code IS NOT NULL AND NEW.scan_code IS NOT OLD.scan_code
        AND NEW.object_key IS NOT OLD.object_key))
  ))
BEGIN SELECT RAISE(ABORT, 'pending credential transfer is locked'); END;

-- pass_published assigns exactly one new revision after the final object-key update. Do not
-- let any other pending write alter and then restore the source revision (an ABA snapshot).
CREATE TRIGGER pass_credential_transfer_pending_revision_guard
BEFORE UPDATE OF revision ON passes
WHEN NEW.revision IS NOT OLD.revision AND EXISTS (
  SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = OLD.id AND t.state = 'pending'
    AND NOT (OLD.credential_generation = t.target_generation AND NEW.revision > OLD.revision
      AND EXISTS (SELECT 1 FROM revisions r WHERE r.revision = NEW.revision AND r.pass_id = OLD.id))
)
BEGIN SELECT RAISE(ABORT, 'pending credential transfer revision is locked'); END;

-- Holder changes and replacement of existing Apple/scanner credentials must go through a
-- transfer: a generation bump alone cannot retire native credentials or tombstone old codes.
-- Initial scan-code backfill is not a replacement and remains a same-holder operation.
CREATE TRIGGER pass_credential_transfer_required
BEFORE UPDATE OF holder_email, owner_user_id, serial, auth_token, scan_code, identity_id, org_id, mode ON passes
WHEN NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = OLD.id AND t.state = 'pending')
  AND (NEW.holder_email IS NOT OLD.holder_email OR NEW.owner_user_id IS NOT OLD.owner_user_id
    OR NEW.serial IS NOT OLD.serial OR NEW.auth_token IS NOT OLD.auth_token
    OR NEW.identity_id IS NOT OLD.identity_id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
    OR (OLD.scan_code IS NOT NULL AND NEW.scan_code IS NOT OLD.scan_code))
BEGIN SELECT RAISE(ABORT, 'credential transfer required'); END;

-- Barcode and lookup values can legitimately change for the same holder at publication.
-- Their existing values are guarded by a new pass version/revision rather than a new
-- credential incarnation; first-time backfills do not invalidate that incarnation.
CREATE TRIGGER pass_credential_lookup_revision_guard
BEFORE UPDATE OF barcode_hash, lookup_hash ON passes
WHEN NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = OLD.id AND t.state = 'pending')
  AND ((OLD.barcode_hash IS NOT NULL AND NEW.barcode_hash IS NOT OLD.barcode_hash)
    OR (OLD.lookup_hash IS NOT NULL AND NEW.lookup_hash IS NOT OLD.lookup_hash))
  AND NEW.version <= OLD.version AND NEW.revision <= OLD.revision
BEGIN SELECT RAISE(ABORT, 'barcode or lookup change requires a new pass version'); END;

-- Only keyed, organization/mode-scoped digests of former possession credentials are stored.
-- There is deliberately no pass FK: purging a pass must not make an old identifier reusable.
CREATE TABLE pass_credential_tombstones (
  pass_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  credential_generation INTEGER NOT NULL CHECK (typeof(credential_generation) = 'integer'
    AND credential_generation BETWEEN 1 AND 9007199254740991),
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('scan_code', 'barcode', 'lookup', 'serial')),
  credential_hash TEXT NOT NULL CHECK (length(credential_hash) = 64 AND credential_hash NOT GLOB '*[^0-9a-f]*'),
  retired_at INTEGER NOT NULL CHECK (typeof(retired_at) = 'integer' AND retired_at >= 0),
  PRIMARY KEY (pass_id, credential_generation, credential_kind, credential_hash)
);
CREATE INDEX pass_credential_tombstones_lookup ON pass_credential_tombstones(org_id, mode, credential_hash);
CREATE TRIGGER pass_credential_tombstones_insert_guard
BEFORE INSERT ON pass_credential_tombstones
WHEN NOT EXISTS (SELECT 1 FROM pass_credential_transfers t JOIN passes p ON p.id = t.pass_id
  WHERE t.pass_id = NEW.pass_id AND t.org_id = NEW.org_id AND t.mode = NEW.mode
    AND t.source_generation = NEW.credential_generation AND t.state = 'pending'
    AND p.org_id = t.org_id AND p.mode = t.mode AND p.credential_generation = t.target_generation
    AND p.version = t.source_version AND p.revision = t.source_revision
    AND p.lifecycle_generation = t.source_lifecycle_generation AND p.link_generation = t.source_link_generation)
  OR EXISTS (SELECT 1 FROM pass_credential_tombstones existing WHERE existing.pass_id = NEW.pass_id
    AND existing.credential_generation = NEW.credential_generation AND existing.credential_kind = NEW.credential_kind
    AND existing.credential_hash = NEW.credential_hash AND (existing.org_id IS NOT NEW.org_id
      OR existing.mode IS NOT NEW.mode OR existing.retired_at IS NOT NEW.retired_at))
BEGIN SELECT RAISE(ABORT, 'invalid credential tombstone'); END;
CREATE TRIGGER pass_credential_tombstones_no_update BEFORE UPDATE ON pass_credential_tombstones
BEGIN SELECT RAISE(ABORT, 'credential tombstone is immutable'); END;
CREATE TRIGGER pass_credential_tombstones_no_delete BEFORE DELETE ON pass_credential_tombstones
BEGIN SELECT RAISE(ABORT, 'credential tombstone is immutable'); END;
-- The oldest configured KEK determines all persisted credential references. Pin it once:
-- replacing or deleting this row would otherwise make old identifiers appear unretired.
CREATE TABLE credential_ref_keyset (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  commitment TEXT NOT NULL
);
-- Keep the event predicate shared by both initialization paths. This view only uses
-- columns available in 0042; other reference stores and columns arrive later.
CREATE VIEW credential_ref_keyset_blocking_events AS
SELECT 1 AS present FROM pass_events WHERE CASE WHEN json_valid(data)
  THEN json_type(data, '$.authority.credentialKeysetCommitment') IS NOT NULL
    OR json_type(data, '$.authority.eventProof') IS NOT NULL
    OR json_type(data, '$.actionIdRef') IS NOT NULL
    OR json_extract(data, '$.authority.scannerCsrfProof') IS NOT NULL
    OR json_extract(data, '$.authority.sessionCsrfProof') IS NOT NULL
    OR (kind LIKE 'scan.%' AND EXISTS (
      SELECT 1 FROM json_tree(data) field
      WHERE typeof(field.key) = 'text' AND field.type IN ('text', 'object', 'array')
        AND (
          (lower(field.key) GLOB '*ref' OR lower(field.key) GLOB '*refs'
            OR lower(field.key) GLOB '*reference' OR lower(field.key) GLOB '*references')
          OR (lower(field.key) GLOB '*referencecode' OR lower(field.key) GLOB '*hash*'
            OR lower(field.key) GLOB '*proof*' OR lower(field.key) GLOB '*secret*')
          OR (lower(field.key) GLOB '*token*' OR lower(field.key) GLOB '*keyset*'
            OR lower(field.key) GLOB '*signature*' OR lower(field.key) GLOB '*nonce*')
          OR (lower(field.key) GLOB '*apikey*' OR lower(field.key) GLOB '*privatekey*'
            OR lower(field.key) GLOB '*password*' OR lower(field.key) GLOB '*passcode*')
          OR (lower(field.key) GLOB '*scancode*' OR lower(field.key) GLOB '*barcode*'
            OR lower(field.key) GLOB '*serialnumber*' OR lower(field.key) GLOB '*csrf*')
          OR (lower(field.key) IN ('credential', 'credentials', 'pin')
            OR lower(field.key) GLOB '*credentialvalue*' OR lower(field.key) GLOB '*credentialdata*')
          OR (lower(field.key) GLOB '*staffpin' OR lower(field.key) GLOB '*hmac*'
            OR lower(field.key) GLOB '*mac' OR lower(field.key) GLOB '*macs')
        )
    )) ELSE 1 END;

-- Group individual EXISTS checks to bound expression depth without compound SELECTs.
-- Keep these predicates in sync with credentialRefKeysetInitializeStmt.
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
  OR EXISTS (SELECT 1 FROM scan_passless_proofs)
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
CREATE TRIGGER credential_ref_keyset_no_update BEFORE UPDATE ON credential_ref_keyset
BEGIN SELECT RAISE(ABORT, 'credential reference keyset is immutable'); END;
CREATE TRIGGER credential_ref_keyset_no_delete BEFORE DELETE ON credential_ref_keyset
BEGIN SELECT RAISE(ABORT, 'credential reference keyset is immutable'); END;

-- A passless refusal still records the exact keyset used to exclude candidates.
CREATE TRIGGER scan_passless_credential_keyset_guard
BEFORE INSERT ON scan_passless_proofs
WHEN json_type(NEW.scope_json, '$.credentialKeysetCommitment') IS NOT 'text'
  OR length(json_extract(NEW.scope_json, '$.credentialKeysetCommitment')) <> 64
  OR json_extract(NEW.scope_json, '$.credentialKeysetCommitment') GLOB '*[^0-9a-f]*'
  OR NOT EXISTS (SELECT 1 FROM credential_ref_keyset
    WHERE id = 1 AND commitment = json_extract(NEW.scope_json, '$.credentialKeysetCommitment'))
BEGIN SELECT RAISE(ABORT, 'invalid passless credential keyset'); END;

-- An eligible waiting holder whose scanner identifier cannot be rotated needs an explicit
-- reissue action. The single row is a current-pass snapshot, not an attachment or credential.
CREATE TABLE pass_holder_reissue_required (
  pass_id TEXT NOT NULL PRIMARY KEY REFERENCES passes(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_generation INTEGER NOT NULL CHECK (typeof(credential_generation) = 'integer' AND credential_generation > 0),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version > 0),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 0),
  lifecycle_generation INTEGER NOT NULL CHECK (typeof(lifecycle_generation) = 'integer' AND lifecycle_generation >= 0),
  link_generation INTEGER NOT NULL CHECK (typeof(link_generation) = 'integer' AND link_generation > 0),
  release_id TEXT,
  detected_at INTEGER NOT NULL CHECK (typeof(detected_at) = 'integer' AND detected_at >= 0)
);
CREATE INDEX pass_holder_reissue_required_org ON pass_holder_reissue_required(org_id);
CREATE INDEX pass_holder_reissue_required_user ON pass_holder_reissue_required(user_id);

CREATE TRIGGER pass_holder_reissue_required_insert_guard
BEFORE INSERT ON pass_holder_reissue_required
WHEN NOT EXISTS (
  SELECT 1 FROM passes p JOIN orgs org ON org.id = p.org_id AND org.status = 'active'
  JOIN users u ON u.id = NEW.user_id AND u.status = 'active'
  JOIN user_emails email ON email.user_id = u.id AND email.email = p.holder_email
  WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode
    AND p.holder_email IS NOT NULL AND p.owner_user_id IS NULL
    AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
    AND p.credential_generation = NEW.credential_generation AND p.version = NEW.version
    AND p.revision = NEW.revision AND p.lifecycle_generation = NEW.lifecycle_generation
    AND p.link_generation = NEW.link_generation AND p.release_id IS NEW.release_id
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')
    AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks block WHERE block.pass_id = p.id AND block.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM users other JOIN user_emails other_email ON other_email.user_id = other.id
      WHERE other.id != u.id AND other.status = 'active' AND other_email.email = p.holder_email
        AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks block WHERE block.pass_id = p.id AND block.user_id = other.id))
)
BEGIN SELECT RAISE(ABORT, 'invalid holder reissue requirement'); END;

CREATE TRIGGER pass_holder_reissue_required_update_guard
BEFORE UPDATE ON pass_holder_reissue_required
WHEN OLD.pass_id IS NOT NEW.pass_id OR NOT EXISTS (
  SELECT 1 FROM passes p JOIN orgs org ON org.id = p.org_id AND org.status = 'active'
  JOIN users u ON u.id = NEW.user_id AND u.status = 'active'
  JOIN user_emails email ON email.user_id = u.id AND email.email = p.holder_email
  WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode
    AND p.holder_email IS NOT NULL AND p.owner_user_id IS NULL
    AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
    AND p.credential_generation = NEW.credential_generation AND p.version = NEW.version
    AND p.revision = NEW.revision AND p.lifecycle_generation = NEW.lifecycle_generation
    AND p.link_generation = NEW.link_generation AND p.release_id IS NEW.release_id
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')
    AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks block WHERE block.pass_id = p.id AND block.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM users other JOIN user_emails other_email ON other_email.user_id = other.id
      WHERE other.id != u.id AND other.status = 'active' AND other_email.email = p.holder_email
        AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks block WHERE block.pass_id = p.id AND block.user_id = other.id))
)
BEGIN SELECT RAISE(ABORT, 'invalid holder reissue requirement'); END;

-- Stale snapshots are no longer actionable; this also clears the requirement as a transfer
-- reserves a new generation. A failed D1 batch rolls the deletion back with the pass update.
CREATE TRIGGER pass_holder_reissue_required_pass_changed
AFTER UPDATE OF org_id, mode, holder_email, owner_user_id, status, deleted_at, removed_at,
  test_data_quarantined, credential_generation, version, revision, lifecycle_generation,
  link_generation, release_id ON passes
BEGIN
  DELETE FROM pass_holder_reissue_required WHERE pass_id = OLD.id AND (
    org_id IS NOT NEW.org_id OR mode IS NOT NEW.mode OR OLD.holder_email IS NOT NEW.holder_email
    OR NEW.owner_user_id IS NOT NULL OR OLD.status IS NOT NEW.status OR NEW.deleted_at IS NOT NULL
    OR OLD.removed_at IS NOT NEW.removed_at OR NEW.test_data_quarantined != 0
    OR credential_generation IS NOT NEW.credential_generation OR version IS NOT NEW.version
    OR revision IS NOT NEW.revision OR lifecycle_generation IS NOT NEW.lifecycle_generation
    OR link_generation IS NOT NEW.link_generation OR release_id IS NOT NEW.release_id);
END;

CREATE TRIGGER pass_holder_reissue_required_transfer_completed
AFTER UPDATE OF state ON pass_credential_transfers
WHEN OLD.state = 'pending' AND NEW.state = 'completed'
BEGIN
  DELETE FROM pass_holder_reissue_required WHERE pass_id = NEW.pass_id;
END;

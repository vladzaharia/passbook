-- A provider account belongs to exactly one tenant and one operating mode. The stable row
-- survives revocation and reconfiguration, including the Google object-identifier HMAC key.
CREATE TABLE wallet_provider_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'samsung')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0),
  credential_id TEXT,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (org_id, mode, provider),
  UNIQUE (id, org_id, mode, provider),
  CHECK ((revision = 0 AND credential_id IS NULL AND revoked_at IS NULL)
    OR (revision > 0 AND credential_id IS NOT NULL))
);

-- Credential versions and account events are append-only. Every version has a fresh encrypted
-- envelope; no provider identifier, secret, or key is stored in plaintext.
CREATE TABLE wallet_provider_credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider TEXT NOT NULL,
  kek_version INTEGER NOT NULL CHECK (kek_version > 0),
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id, org_id, mode, provider)
    REFERENCES wallet_provider_accounts(id, org_id, mode, provider)
);
CREATE INDEX wallet_provider_credentials_account ON wallet_provider_credentials(account_id, created_at);
CREATE INDEX wallet_provider_credentials_scope_fk ON wallet_provider_credentials(account_id, org_id, mode, provider);

CREATE TABLE wallet_provider_account_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  kind TEXT NOT NULL CHECK (kind IN ('configure', 'revoke')),
  credential_id TEXT NOT NULL REFERENCES wallet_provider_credentials(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, revision),
  FOREIGN KEY (account_id, org_id, mode, provider)
    REFERENCES wallet_provider_accounts(id, org_id, mode, provider)
);
CREATE INDEX wallet_provider_account_events_scope_fk ON wallet_provider_account_events(account_id, org_id, mode, provider);
CREATE INDEX wallet_provider_account_events_credential_fk ON wallet_provider_account_events(credential_id);
CREATE INDEX wallet_provider_account_events_actor_fk ON wallet_provider_account_events(actor_id);

CREATE TRIGGER wallet_provider_credentials_no_update BEFORE UPDATE ON wallet_provider_credentials
BEGIN SELECT RAISE(ABORT, 'immutable wallet provider credential'); END;
CREATE TRIGGER wallet_provider_credentials_no_delete BEFORE DELETE ON wallet_provider_credentials
BEGIN SELECT RAISE(ABORT, 'immutable wallet provider credential'); END;
CREATE TRIGGER wallet_provider_account_events_no_update BEFORE UPDATE ON wallet_provider_account_events
BEGIN SELECT RAISE(ABORT, 'immutable wallet provider event'); END;
CREATE TRIGGER wallet_provider_account_events_no_delete BEFORE DELETE ON wallet_provider_account_events
BEGIN SELECT RAISE(ABORT, 'immutable wallet provider event'); END;
CREATE TRIGGER wallet_provider_accounts_no_delete BEFORE DELETE ON wallet_provider_accounts
BEGIN SELECT RAISE(ABORT, 'immutable wallet provider account'); END;

-- The event commits the exact state transition; even a direct account update cannot silently
-- replace a credential, preserve approval across rotation, or roll back the revision.
CREATE TRIGGER wallet_provider_accounts_transition BEFORE UPDATE ON wallet_provider_accounts
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
  OR NEW.provider IS NOT OLD.provider OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision != OLD.revision + 1
  OR NOT EXISTS (
    SELECT 1 FROM wallet_provider_account_events e
    JOIN wallet_provider_credentials c ON c.id = e.credential_id
      AND c.account_id = NEW.id AND c.org_id = NEW.org_id
      AND c.mode = NEW.mode AND c.provider = NEW.provider
    WHERE e.account_id = NEW.id AND e.org_id = NEW.org_id AND e.mode = NEW.mode
      AND e.provider = NEW.provider AND e.revision = NEW.revision
      AND e.credential_id = NEW.credential_id AND e.created_at = NEW.updated_at
      AND ((e.kind = 'configure' AND NEW.credential_id IS NOT OLD.credential_id AND NEW.revoked_at IS NULL)
        OR (e.kind = 'revoke' AND OLD.credential_id IS NOT NULL AND OLD.revoked_at IS NULL
            AND NEW.credential_id = OLD.credential_id
            AND NEW.revoked_at IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM wallet_provider_instances i WHERE i.account_id = OLD.id AND i.lifecycle != 'retired')))
  )
BEGIN SELECT RAISE(ABORT, 'invalid wallet provider account transition'); END;

-- Insert the redacted audit row in the same transaction as the accepted transition.
CREATE TRIGGER wallet_provider_accounts_audit AFTER UPDATE ON wallet_provider_accounts
BEGIN
  INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
  SELECT e.created_at, e.org_id, 'user', e.actor_id, 'wallet_provider.account_' || e.kind,
    'wallet_provider_account', e.account_id, e.request_id, NULL,
    json_object('mode', e.mode, 'provider', e.provider, 'revision', e.revision)
  FROM wallet_provider_account_events e WHERE e.account_id = NEW.id AND e.revision = NEW.revision;
END;

-- Each holder incarnation has a distinct immutable provider identity. The source projection
-- stays pinned for retirement even when a later holder receives a different incarnation.
CREATE TABLE wallet_provider_instances (
  id TEXT PRIMARY KEY,
  pass_id TEXT NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'samsung')),
  account_id TEXT REFERENCES wallet_provider_accounts(id),
  identity_projection_release_id TEXT REFERENCES template_releases(id),
  credential_generation INTEGER NOT NULL CHECK(typeof(credential_generation) = 'integer' AND credential_generation >= 1),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('blocked', 'ready', 'active', 'revoking', 'revoked', 'retired')),
  desired_version INTEGER NOT NULL CHECK (typeof(desired_version) = 'integer' AND desired_version >= 0),
  desired_operation_id TEXT,
  installation_state TEXT NOT NULL DEFAULT 'unknown' CHECK (installation_state = 'unknown'),
  installation_observed_at INTEGER CHECK (installation_observed_at IS NULL),
  revoked_at INTEGER,
  retired_at INTEGER,
  retirement_reason TEXT CHECK(retirement_reason IS NULL OR retirement_reason = 'not_issued'),
  retirement_requested_at INTEGER,
  retirement_next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pass_id, provider, credential_generation),
  CHECK (
    (lifecycle IN ('blocked', 'ready') AND account_id IS NULL AND identity_projection_release_id IS NULL
      AND desired_operation_id IS NULL AND desired_version = 0 AND retirement_reason IS NULL
      AND retired_at IS NULL AND installation_state = 'unknown')
    OR (lifecycle = 'retired' AND account_id IS NULL AND identity_projection_release_id IS NULL
      AND desired_operation_id IS NULL AND desired_version = 0 AND retirement_reason IS NOT NULL AND retirement_reason = 'not_issued'
      AND retired_at IS NOT NULL AND installation_state = 'unknown')
    OR (lifecycle IN ('active', 'revoking', 'revoked', 'retired') AND account_id IS NOT NULL
      AND identity_projection_release_id IS NOT NULL AND desired_operation_id IS NOT NULL
      AND desired_version > 0 AND retirement_reason IS NULL)
  )
);
CREATE UNIQUE INDEX wallet_provider_instances_one_active ON wallet_provider_instances(pass_id, provider) WHERE lifecycle NOT IN ('blocked', 'retired');
CREATE INDEX wallet_provider_instances_scope ON wallet_provider_instances(org_id, mode, provider, pass_id);
CREATE INDEX wallet_provider_instances_retirement_due ON wallet_provider_instances(lifecycle, retirement_next_attempt_at, id);
CREATE INDEX wallet_provider_instances_account_fk ON wallet_provider_instances(account_id);
CREATE INDEX wallet_provider_instances_projection_fk ON wallet_provider_instances(identity_projection_release_id);
CREATE TRIGGER wallet_provider_instances_identity_immutable
BEFORE UPDATE OF id, pass_id, org_id, mode, provider, credential_generation ON wallet_provider_instances
BEGIN SELECT RAISE(ABORT, 'provider instance identity is immutable'); END;
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
        AND c.provider_account_revision = a.revision
      JOIN wallet_provider_instance_operations op ON op.id = NEW.desired_operation_id
        AND op.instance_id = NEW.id AND op.version = NEW.desired_version AND op.kind = 'upsert'
        AND op.pass_credential_generation = NEW.credential_generation
      WHERE a.id = NEW.account_id AND a.org_id = NEW.org_id AND a.mode = NEW.mode
        AND a.provider = NEW.provider AND a.credential_id IS NOT NULL AND a.revoked_at IS NULL
    ))
BEGIN SELECT RAISE(ABORT, 'provider instance binding is immutable'); END;
CREATE TRIGGER wallet_provider_instances_no_delete BEFORE DELETE ON wallet_provider_instances
WHEN OLD.lifecycle != 'retired' OR (OLD.provider = 'google' AND OLD.desired_version > 0)
BEGIN SELECT RAISE(ABORT, 'provider instance retirement required'); END;
CREATE TRIGGER wallet_provider_instances_retirement_immutable
BEFORE UPDATE OF retirement_requested_at ON wallet_provider_instances
WHEN OLD.retirement_requested_at IS NOT NULL AND NEW.retirement_requested_at IS NOT OLD.retirement_requested_at
BEGIN SELECT RAISE(ABORT, 'provider retirement intent is immutable'); END;

-- Every desired operation has a monotonic version and immutable authority snapshot. Only hashes of
-- request keys/claim handles are stored; no provider request/response bodies or credentials are kept.
CREATE TABLE wallet_provider_instance_operations (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  kind TEXT NOT NULL CHECK (kind IN ('upsert', 'revoke')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  pass_version INTEGER NOT NULL CHECK (pass_version > 0),
  pass_revision INTEGER NOT NULL CHECK (pass_revision >= 0),
  pass_credential_generation INTEGER NOT NULL CHECK(typeof(pass_credential_generation) = 'integer' AND pass_credential_generation >= 1),
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
  issuing_release_id TEXT REFERENCES template_releases(id),
  projection_release_id TEXT NOT NULL REFERENCES template_releases(id),
  account_revision INTEGER NOT NULL CHECK (account_revision > 0),
  adapter_revision INTEGER NOT NULL CHECK (adapter_revision > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'retry', 'succeeded', 'failed', 'superseded', 'uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at INTEGER,
  claim_hash TEXT CHECK (claim_hash IS NULL OR (length(claim_hash) = 64 AND claim_hash NOT GLOB '*[^0-9a-f]*')),
  claim_expires_at INTEGER,
  last_attempt_at INTEGER,
  last_result_at INTEGER,
  completed_at INTEGER,
  reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN
    ('ok', 'not_issued', 'rate_limited', 'unavailable', 'timeout', 'unauthorized', 'rejected', 'invalid_response', 'provider_error')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  created_at INTEGER NOT NULL,
  UNIQUE (instance_id, version),
  UNIQUE (instance_id, request_hash),
  CHECK (kind != 'upsert' OR issuing_release_id IS NOT NULL),
  CHECK ((state IN ('claimed', 'uncertain') AND claim_hash IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR state NOT IN ('claimed', 'uncertain'))
);
-- An expired claim remains in-flight until a caller knows that its external request has settled.
-- This deliberately prevents revocation from racing an older, ambiguous provider write.
CREATE UNIQUE INDEX wallet_provider_instance_one_inflight
  ON wallet_provider_instance_operations(instance_id) WHERE state IN ('claimed', 'uncertain');
CREATE INDEX wallet_provider_instance_operations_due
  ON wallet_provider_instance_operations(state, next_attempt_at, created_at);
CREATE INDEX wallet_provider_operations_issuing_fk ON wallet_provider_instance_operations(issuing_release_id);
CREATE INDEX wallet_provider_operations_projection_fk ON wallet_provider_instance_operations(projection_release_id);
CREATE TRIGGER wallet_provider_instance_operation_snapshot_immutable
BEFORE UPDATE OF instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
  lifecycle_generation, issuing_release_id, projection_release_id, account_revision,
  adapter_revision, policy_revision ON wallet_provider_instance_operations
BEGIN SELECT RAISE(ABORT, 'provider operation snapshot is immutable'); END;
CREATE TRIGGER wallet_provider_instance_operation_insert_guard BEFORE INSERT ON wallet_provider_instance_operations
WHEN NOT EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = NEW.instance_id
  AND i.lifecycle IN ('ready', 'active', 'revoking', 'revoked'))
BEGIN SELECT RAISE(ABORT, 'provider operation requires a live instance'); END;
CREATE TRIGGER wallet_provider_instance_operation_delete_guard BEFORE DELETE ON wallet_provider_instance_operations
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = OLD.instance_id AND i.lifecycle != 'retired')
BEGIN SELECT RAISE(ABORT, 'provider operation history is retained'); END;

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
  OR (NEW.lifecycle = 'retired' AND OLD.provider = 'google' AND OLD.desired_version > 0)
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

CREATE TABLE wallet_provider_offer_refs (
  ref_hash TEXT PRIMARY KEY CHECK (length(ref_hash) = 64 AND ref_hash NOT GLOB '*[^0-9a-f]*'),
  instance_id TEXT NOT NULL REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  operation_version INTEGER NOT NULL CHECK (operation_version > 0),
  pass_authority_generation INTEGER NOT NULL DEFAULT 0 CHECK(pass_authority_generation >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 300000),
  consumed_at INTEGER,
  delivered_at INTEGER,
  CHECK (delivered_at IS NULL OR (consumed_at IS NOT NULL AND delivered_at >= consumed_at AND delivered_at < expires_at))
);
CREATE TABLE wallet_provider_pass_authority (
  pass_id TEXT PRIMARY KEY REFERENCES passes(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation > 0)
);
CREATE TRIGGER wallet_provider_pass_authority_changed
AFTER UPDATE OF download_token, owner_user_id, holder_email, link_generation ON passes
WHEN OLD.download_token IS NOT NEW.download_token OR OLD.owner_user_id IS NOT NEW.owner_user_id
  OR OLD.holder_email IS NOT NEW.holder_email OR OLD.link_generation IS NOT NEW.link_generation
BEGIN
  INSERT INTO wallet_provider_pass_authority(pass_id, generation) VALUES (NEW.id, 1)
  ON CONFLICT(pass_id) DO UPDATE SET generation = generation + 1;
END;
CREATE INDEX wallet_provider_offer_refs_expiry ON wallet_provider_offer_refs(expires_at);
CREATE INDEX wallet_provider_offer_refs_instance_fk ON wallet_provider_offer_refs(instance_id);

-- Hashed callback observations are not evidence of installation on a particular device.
CREATE TABLE wallet_provider_callback_events (
  account_id TEXT NOT NULL REFERENCES wallet_provider_accounts(id),
  event_id_hash TEXT NOT NULL CHECK (length(event_id_hash) = 64 AND event_id_hash NOT GLOB '*[^0-9a-f]*'),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  instance_id TEXT NOT NULL REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  operation_version INTEGER NOT NULL CHECK (operation_version > 0),
  kind TEXT NOT NULL CHECK (kind IN ('installed', 'uninstalled', 'other')),
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, event_id_hash)
);
CREATE INDEX wallet_provider_callback_events_instance ON wallet_provider_callback_events(instance_id, received_at);

CREATE TABLE wallet_provider_instance_outcomes (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES wallet_provider_instance_operations(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 8),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  event_hash TEXT NOT NULL CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  reason_code TEXT CHECK(reason_code IS NULL OR reason_code IN ('ok', 'not_issued', 'rate_limited', 'unavailable', 'timeout', 'unauthorized', 'rejected', 'invalid_response', 'provider_error')),
  http_status INTEGER CHECK(http_status IS NULL OR http_status BETWEEN 100 AND 599),
  kek_version INTEGER NOT NULL,
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(operation_id, attempt, event_hash),
  UNIQUE(operation_id, attempt, sequence)
);
CREATE TABLE wallet_provider_instance_dirty (
  instance_id TEXT PRIMARY KEY REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation > 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX wallet_provider_instance_dirty_due ON wallet_provider_instance_dirty(next_attempt_at, instance_id);
CREATE TRIGGER wallet_provider_dirty_pass
AFTER UPDATE OF version, revision, lifecycle_generation, status, deleted_at, removed_at, release_id,
  org_id, mode, download_token, owner_user_id, holder_email, link_generation ON passes
WHEN OLD.version IS NOT NEW.version OR OLD.revision IS NOT NEW.revision
  OR OLD.lifecycle_generation IS NOT NEW.lifecycle_generation OR OLD.status IS NOT NEW.status
  OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.removed_at IS NOT NEW.removed_at
  OR OLD.release_id IS NOT NEW.release_id OR OLD.org_id IS NOT NEW.org_id OR OLD.mode IS NOT NEW.mode
  OR OLD.download_token IS NOT NEW.download_token OR OLD.owner_user_id IS NOT NEW.owner_user_id
  OR OLD.holder_email IS NOT NEW.holder_email OR OLD.link_generation IS NOT NEW.link_generation
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE pass_id = NEW.id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;
CREATE TRIGGER wallet_provider_dirty_account AFTER UPDATE OF revision ON wallet_provider_accounts
WHEN OLD.revision IS NOT NEW.revision
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE account_id = NEW.id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;
CREATE TRIGGER wallet_provider_dirty_release AFTER INSERT ON template_releases
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT i.id, 1 FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id
  WHERE p.template_id = NEW.template_id AND i.mode = NEW.mode
    AND (NEW.org_id = i.org_id OR NEW.org_id IS NULL)
    AND (NEW.provider = 'apple' OR NEW.provider = i.provider)
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;

CREATE TRIGGER wallet_provider_dirty_assets_insert AFTER INSERT ON pass_assets
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE pass_id = NEW.pass_id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;
CREATE TRIGGER wallet_provider_dirty_assets_update AFTER UPDATE ON pass_assets
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE pass_id = NEW.pass_id OR pass_id = OLD.pass_id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;
CREATE TRIGGER wallet_provider_dirty_assets_delete AFTER DELETE ON pass_assets
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE pass_id = OLD.pass_id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;
CREATE TRIGGER wallet_provider_dirty_photo_insert AFTER INSERT ON member_photos
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE pass_id = NEW.pass_id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;
CREATE TRIGGER wallet_provider_dirty_photo_update AFTER UPDATE ON member_photos
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE pass_id = NEW.pass_id OR pass_id = OLD.pass_id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;
CREATE TRIGGER wallet_provider_dirty_photo_delete AFTER DELETE ON member_photos
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE pass_id = OLD.pass_id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;
CREATE TRIGGER wallet_provider_dirty_template AFTER UPDATE OF status, origin, active_version ON templates
WHEN OLD.status IS NOT NEW.status OR OLD.origin IS NOT NEW.origin OR OLD.active_version IS NOT NEW.active_version
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT i.id, 1 FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id WHERE p.template_id = NEW.id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;
CREATE TRIGGER wallet_provider_dirty_org AFTER UPDATE OF status, branding ON orgs
WHEN OLD.status IS NOT NEW.status OR OLD.branding IS NOT NEW.branding
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE org_id = NEW.id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;

CREATE TABLE wallet_samsung_fetch_refs (
  id TEXT PRIMARY KEY,
  ref_hash TEXT NOT NULL UNIQUE CHECK(length(ref_hash)=64 AND ref_hash NOT GLOB '*[^0-9a-f]*'),
  instance_id TEXT NOT NULL REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_offered_at INTEGER NOT NULL,
  initial_expires_at INTEGER NOT NULL CHECK(initial_expires_at > last_offered_at AND initial_expires_at <= last_offered_at + 300000),
  promoted_at INTEGER,
  retired_at INTEGER,
  kek_version INTEGER NOT NULL CHECK(kek_version > 0),
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  CHECK(promoted_at IS NULL OR promoted_at >= created_at),
  CHECK(retired_at IS NULL OR retired_at >= created_at)
);
CREATE INDEX wallet_samsung_fetch_refs_instance ON wallet_samsung_fetch_refs(instance_id);
CREATE UNIQUE INDEX wallet_samsung_fetch_refs_one_active ON wallet_samsung_fetch_refs(instance_id) WHERE retired_at IS NULL;
CREATE TRIGGER wallet_samsung_fetch_ref_no_tombstone_reuse BEFORE INSERT ON wallet_samsung_fetch_refs
WHEN EXISTS (SELECT 1 FROM wallet_samsung_tombstones t WHERE t.ref_hash = NEW.ref_hash)
BEGIN SELECT RAISE(ABORT, 'retired Samsung reference cannot be reused'); END;
CREATE TABLE wallet_samsung_auth_replays (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=43),
  claim_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX wallet_samsung_auth_replays_expiry ON wallet_samsung_auth_replays(expires_at);
CREATE TABLE wallet_samsung_callback_receipts (
  id TEXT PRIMARY KEY,
  ref_id TEXT NOT NULL REFERENCES wallet_samsung_fetch_refs(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES wallet_provider_accounts(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK(mode IN ('live', 'test')),
  operation_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind = 'state_callback'),
  signed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  kek_version INTEGER NOT NULL CHECK(kek_version > 0),
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL
);
CREATE INDEX wallet_samsung_callback_receipts_instance ON wallet_samsung_callback_receipts(instance_id, received_at);
CREATE INDEX wallet_samsung_callback_receipts_ref_fk ON wallet_samsung_callback_receipts(ref_id);
CREATE INDEX wallet_samsung_callback_receipts_account_fk ON wallet_samsung_callback_receipts(account_id);
CREATE INDEX wallet_samsung_callback_receipts_org_fk ON wallet_samsung_callback_receipts(org_id);
CREATE TABLE wallet_samsung_country_hints (
  ref_id TEXT NOT NULL REFERENCES wallet_samsung_fetch_refs(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL CHECK(length(country_code)=2 AND country_code NOT GLOB '*[^A-Z]*'),
  received_at INTEGER NOT NULL,
  PRIMARY KEY(ref_id, country_code)
);

CREATE TABLE wallet_provider_sync_targets (
  operation_id TEXT NOT NULL REFERENCES wallet_provider_instance_operations(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL CHECK(length(country_code)=2 AND country_code NOT GLOB '*[^A-Z]*'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'inflight', 'retry', 'succeeded', 'failed', 'uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  next_attempt_at INTEGER,
  reason_code TEXT CHECK(reason_code IS NULL OR reason_code IN ('ok', 'rate_limited', 'unavailable', 'timeout', 'unauthorized', 'rejected', 'invalid_response', 'provider_error')),
  http_status INTEGER CHECK(http_status IS NULL OR http_status BETWEEN 100 AND 599),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id, country_code)
);
CREATE INDEX wallet_provider_sync_targets_due ON wallet_provider_sync_targets(state, next_attempt_at);

CREATE TABLE wallet_google_callback_bindings (
  instance_id TEXT PRIMARY KEY REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES wallet_provider_accounts(id),
  class_id_hash TEXT NOT NULL CHECK(length(class_id_hash)=64 AND class_id_hash NOT GLOB '*[^0-9a-f]*'),
  object_id_hash TEXT NOT NULL CHECK(length(object_id_hash)=64 AND object_id_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, object_id_hash)
);
CREATE INDEX wallet_google_callback_bindings_lookup ON wallet_google_callback_bindings(account_id, class_id_hash, object_id_hash);
CREATE TABLE wallet_google_callback_receipts (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES wallet_provider_accounts(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK(mode IN ('live', 'test')),
  event_type TEXT NOT NULL CHECK(event_type IN ('save', 'del')),
  nonce_hash TEXT NOT NULL CHECK(length(nonce_hash)=64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  kek_version INTEGER NOT NULL CHECK(kek_version > 0),
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  UNIQUE(account_id, nonce_hash)
);
CREATE INDEX wallet_google_callback_receipts_instance ON wallet_google_callback_receipts(instance_id, received_at);
CREATE INDEX wallet_google_callback_receipts_org_fk ON wallet_google_callback_receipts(org_id);

-- Replay reservations outlive deleted instances.
CREATE TABLE wallet_google_callback_replays (
  account_id TEXT NOT NULL REFERENCES wallet_provider_accounts(id),
  nonce_hash TEXT NOT NULL CHECK(length(nonce_hash)=64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
  claim_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, nonce_hash)
);
CREATE INDEX wallet_google_callback_replays_expiry ON wallet_google_callback_replays(expires_at);

-- No pass or instance foreign key: retired Samsung references must remain recognizable
-- after the source pass is purged, without retaining its identity or personal data.
CREATE TABLE wallet_samsung_tombstones (
  ref_hash TEXT NOT NULL CHECK(length(ref_hash)=64 AND ref_hash NOT GLOB '*[^0-9a-f]*'),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK(mode IN ('live', 'test')),
  account_id TEXT NOT NULL REFERENCES wallet_provider_accounts(id),
  account_revision INTEGER NOT NULL CHECK(account_revision > 0),
  candidate_id TEXT NOT NULL REFERENCES template_candidates(id),
  release_id TEXT NOT NULL REFERENCES template_releases(id),
  provider_identity_hash TEXT NOT NULL CHECK(length(provider_identity_hash)=64 AND provider_identity_hash NOT GLOB '*[^0-9a-f]*'),
  retired_at INTEGER NOT NULL,
  PRIMARY KEY(ref_hash, account_revision)
);
CREATE INDEX wallet_samsung_tombstones_account ON wallet_samsung_tombstones(account_id);
CREATE INDEX wallet_samsung_tombstones_org ON wallet_samsung_tombstones(org_id);
CREATE INDEX wallet_samsung_tombstones_candidate ON wallet_samsung_tombstones(candidate_id);
CREATE INDEX wallet_samsung_tombstones_release ON wallet_samsung_tombstones(release_id);
CREATE TRIGGER wallet_samsung_tombstones_approved_insert BEFORE INSERT ON wallet_samsung_tombstones
WHEN NOT EXISTS (
  SELECT 1 FROM wallet_provider_accounts a JOIN wallet_provider_account_events e
    ON e.account_id = a.id AND e.org_id = a.org_id AND e.mode = a.mode AND e.provider = a.provider
    AND e.revision = NEW.account_revision AND e.kind = 'configure'
  JOIN template_candidates c ON c.id = NEW.candidate_id AND c.provider_account_id = a.id
    AND c.provider_account_revision = NEW.account_revision AND c.provider_identity_hash = NEW.provider_identity_hash
    AND c.org_id = NEW.org_id AND c.mode = NEW.mode AND c.provider = 'samsung'
  JOIN template_releases r ON r.id = NEW.release_id AND r.candidate_id = c.id
    AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = 'samsung' AND r.source = 'approved'
  JOIN wallet_provider_projection_evidence_history h ON h.candidate_id = c.id AND h.org_id = c.org_id
    AND h.mode = c.mode AND h.account_id = a.id AND h.account_revision = NEW.account_revision
    AND h.provider_identity_hash = NEW.provider_identity_hash AND h.candidate_hash = c.candidate_hash
    AND h.card_type = json_extract(c.projection_json, '$.cardType')
    AND h.card_sub_type = json_extract(c.projection_json, '$.cardSubType')
    AND h.country_code = json_extract(c.projection_json, '$.countryCode')
    AND h.testing_mode_off = 'Y' AND h.verified_at <= r.created_at AND r.created_at < h.expires_at
  WHERE a.id = NEW.account_id AND a.org_id = NEW.org_id AND a.mode = NEW.mode AND a.provider = 'samsung'
)
BEGIN SELECT RAISE(ABORT, 'Samsung tombstone requires verified release evidence'); END;
CREATE TRIGGER wallet_samsung_tombstones_no_update BEFORE UPDATE ON wallet_samsung_tombstones
BEGIN SELECT RAISE(ABORT, 'immutable Samsung tombstone'); END;
CREATE TRIGGER wallet_samsung_tombstones_no_delete BEFORE DELETE ON wallet_samsung_tombstones
BEGIN SELECT RAISE(ABORT, 'immutable Samsung tombstone'); END;

-- Current authenticated provider publication-state evidence, scoped to a single immutable candidate.
CREATE TABLE wallet_provider_projection_evidence (
  candidate_id TEXT PRIMARY KEY REFERENCES template_candidates(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK(mode IN ('live', 'test')),
  account_id TEXT NOT NULL REFERENCES wallet_provider_accounts(id),
  account_revision INTEGER NOT NULL CHECK(account_revision > 0),
  provider_identity_hash TEXT NOT NULL CHECK(length(provider_identity_hash)=64),
  candidate_hash TEXT NOT NULL CHECK(length(candidate_hash)=64),
  card_type TEXT NOT NULL,
  card_sub_type TEXT NOT NULL,
  country_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'verified', 'unverified')),
  testing_mode_off TEXT CHECK(testing_mode_off IS NULL OR testing_mode_off IN ('Y', 'N')),
  probe_id TEXT NOT NULL,
  verified_at INTEGER,
  expires_at INTEGER,
  CHECK((status = 'verified' AND testing_mode_off IS NOT NULL AND testing_mode_off = 'Y' AND verified_at IS NOT NULL
      AND expires_at IS NOT NULL AND expires_at > verified_at AND expires_at <= verified_at + 300000)
    OR (status IN ('pending', 'unverified') AND testing_mode_off IS NULL AND verified_at IS NULL AND expires_at IS NULL))
);
CREATE INDEX wallet_provider_projection_evidence_account ON wallet_provider_projection_evidence(account_id, org_id, mode, account_revision);
CREATE INDEX wallet_provider_projection_evidence_org ON wallet_provider_projection_evidence(org_id);

CREATE TABLE wallet_provider_projection_evidence_history (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES template_candidates(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK(mode IN ('live', 'test')),
  account_id TEXT NOT NULL REFERENCES wallet_provider_accounts(id),
  account_revision INTEGER NOT NULL CHECK(account_revision > 0),
  provider_identity_hash TEXT NOT NULL CHECK(length(provider_identity_hash)=64),
  candidate_hash TEXT NOT NULL CHECK(length(candidate_hash)=64),
  card_type TEXT NOT NULL,
  card_sub_type TEXT NOT NULL,
  country_code TEXT NOT NULL,
  testing_mode_off TEXT NOT NULL CHECK(testing_mode_off = 'Y'),
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > verified_at AND expires_at <= verified_at + 300000)
);
CREATE INDEX wallet_provider_projection_evidence_history_candidate ON wallet_provider_projection_evidence_history(candidate_id, verified_at, expires_at);
CREATE INDEX wallet_provider_projection_evidence_history_account ON wallet_provider_projection_evidence_history(account_id);
CREATE INDEX wallet_provider_projection_evidence_history_org ON wallet_provider_projection_evidence_history(org_id);
CREATE TRIGGER wallet_provider_projection_evidence_history_no_update BEFORE UPDATE ON wallet_provider_projection_evidence_history
BEGIN SELECT RAISE(ABORT, 'immutable Samsung provider evidence'); END;
CREATE TRIGGER wallet_provider_projection_evidence_history_no_delete BEFORE DELETE ON wallet_provider_projection_evidence_history
BEGIN SELECT RAISE(ABORT, 'immutable Samsung provider evidence'); END;

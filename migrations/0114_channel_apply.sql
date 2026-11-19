-- Channel apply (design-ch4.md, CH4a). Turning Google or Samsung off retires the provider copy; turning it back on
-- creates a successor instance at the same credential_generation with channel_epoch + 1. The successor needs
-- room next to its predecessor, so UNIQUE (pass_id, provider, credential_generation) becomes
-- UNIQUE (pass_id, provider, credential_generation, channel_epoch), and SQLite cannot drop a table constraint.
-- Also here: channel_apply_runs and channel_apply_marks (the debounced, throttled apply of a template's
-- channel policy), and the triggers that hold the rules.
--
-- Rebuild. D1 keeps foreign keys on, and ALTER TABLE RENAME rewrites the children's REFERENCES even with
-- legacy_alter_table (spiked on local D1: ch4a-results.md), so the instance table cannot be renamed aside.
-- Dropping it would cascade-delete its 8 children (and, through them, 3 more tables), firing their delete
-- guards. So the whole closure is copied to _keep_*, dropped leaf first, recreated parent first and restored;
-- the indexes and triggers come back after the rows, from their current text (0037, 0043, 0050, 0072, 0112).
-- Only the instance table, wallet_provider_instances_one_active, _identity_immutable and
-- wallet_provider_generation_insert_guard change; tools/wallet-instances-rebuild.test.ts diffs sqlite_master.
-- rebuild:begin
PRAGMA defer_foreign_keys = ON;
CREATE TABLE _keep_wallet_provider_instances AS SELECT * FROM wallet_provider_instances;
CREATE TABLE _keep_wallet_provider_instance_operations AS SELECT * FROM wallet_provider_instance_operations;
CREATE TABLE _keep_wallet_provider_offer_refs AS SELECT * FROM wallet_provider_offer_refs;
CREATE TABLE _keep_wallet_provider_callback_events AS SELECT * FROM wallet_provider_callback_events;
CREATE TABLE _keep_wallet_provider_instance_outcomes AS SELECT * FROM wallet_provider_instance_outcomes;
CREATE TABLE _keep_wallet_provider_instance_dirty AS SELECT * FROM wallet_provider_instance_dirty;
CREATE TABLE _keep_wallet_samsung_fetch_refs AS SELECT * FROM wallet_samsung_fetch_refs;
CREATE TABLE _keep_wallet_samsung_callback_receipts AS SELECT * FROM wallet_samsung_callback_receipts;
CREATE TABLE _keep_wallet_samsung_country_hints AS SELECT * FROM wallet_samsung_country_hints;
CREATE TABLE _keep_wallet_provider_sync_targets AS SELECT * FROM wallet_provider_sync_targets;
CREATE TABLE _keep_wallet_google_callback_bindings AS SELECT * FROM wallet_google_callback_bindings;
CREATE TABLE _keep_wallet_google_callback_receipts AS SELECT * FROM wallet_google_callback_receipts;
DROP TABLE wallet_google_callback_receipts;
DROP TABLE wallet_google_callback_bindings;
DROP TABLE wallet_provider_sync_targets;
DROP TABLE wallet_samsung_country_hints;
DROP TABLE wallet_samsung_callback_receipts;
DROP TABLE wallet_samsung_fetch_refs;
DROP TABLE wallet_provider_instance_dirty;
DROP TABLE wallet_provider_instance_outcomes;
DROP TABLE wallet_provider_callback_events;
DROP TABLE wallet_provider_offer_refs;
DROP TABLE wallet_provider_instance_operations;
DROP TABLE wallet_provider_instances;
CREATE TABLE wallet_provider_instances (
  id TEXT PRIMARY KEY,
  pass_id TEXT NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'samsung')),
  account_id TEXT REFERENCES wallet_provider_accounts(id),
  identity_projection_release_id TEXT REFERENCES template_releases(id),
  credential_generation INTEGER NOT NULL CHECK(typeof(credential_generation) = 'integer' AND credential_generation >= 1),
  channel_epoch INTEGER NOT NULL DEFAULT 1 CHECK (typeof(channel_epoch) = 'integer' AND channel_epoch BETWEEN 1 AND 16),
  retirement_cause TEXT CHECK (retirement_cause IS NULL OR retirement_cause = 'channel_off'),
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
  updated_at INTEGER NOT NULL, credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*')), saved_at INTEGER, holder_removed_at INTEGER,
  UNIQUE (pass_id, provider, credential_generation, channel_epoch),
  CHECK (retirement_cause IS NULL OR retirement_requested_at IS NOT NULL),
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
  created_at INTEGER NOT NULL, credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*')), credential_version_id TEXT
  REFERENCES wallet_credential_versions(id),
  UNIQUE (instance_id, version),
  UNIQUE (instance_id, request_hash),
  CHECK (kind != 'upsert' OR issuing_release_id IS NOT NULL),
  CHECK ((state IN ('claimed', 'uncertain') AND claim_hash IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR state NOT IN ('claimed', 'uncertain'))
);
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
  ciphertext BLOB NOT NULL, credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*')), market_cc2 TEXT
  CHECK(market_cc2 IS NULL OR (length(market_cc2) = 2 AND market_cc2 NOT GLOB '*[^A-Z]*')), market_query_bound INTEGER
  CHECK(market_query_bound IS NULL OR market_query_bound IN (0, 1)), served_at INTEGER, credential_version_id TEXT
  REFERENCES wallet_credential_versions(id),
  CHECK(promoted_at IS NULL OR promoted_at >= created_at),
  CHECK(retired_at IS NULL OR retired_at >= created_at)
);
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
, event TEXT
  CHECK(event IS NULL OR event IN ('ADDED', 'DELETED', 'UPDATED', 'PROVISIONED')), cc2 TEXT
  CHECK(cc2 IS NULL OR (length(cc2) = 2 AND cc2 NOT GLOB '*[^A-Z]*')), query_bound INTEGER
  CHECK(query_bound IS NULL OR query_bound IN (0, 1)), token_hash TEXT
  CHECK(token_hash IS NULL OR length(token_hash) = 43), request_id TEXT
  CHECK(request_id IS NULL OR length(request_id) BETWEEN 1 AND 64));
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
CREATE TABLE wallet_google_callback_bindings (
  instance_id TEXT PRIMARY KEY REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES wallet_provider_accounts(id),
  class_id_hash TEXT NOT NULL CHECK(length(class_id_hash)=64 AND class_id_hash NOT GLOB '*[^0-9a-f]*'),
  object_id_hash TEXT NOT NULL CHECK(length(object_id_hash)=64 AND object_id_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL, credential_keyset_commitment TEXT
  CHECK(credential_keyset_commitment IS NULL OR (typeof(credential_keyset_commitment) = 'text'
    AND length(CAST(credential_keyset_commitment AS BLOB)) = 64 AND length(credential_keyset_commitment) = 64
    AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*')),
  UNIQUE(account_id, object_id_hash)
);
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
INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, account_id, identity_projection_release_id, credential_generation, lifecycle, desired_version, desired_operation_id, installation_state, installation_observed_at, revoked_at, retired_at, retirement_reason, retirement_requested_at, retirement_next_attempt_at, created_at, updated_at, credential_keyset_commitment, saved_at, holder_removed_at)
  SELECT id, pass_id, org_id, mode, provider, account_id, identity_projection_release_id, credential_generation, lifecycle, desired_version, desired_operation_id, installation_state, installation_observed_at, revoked_at, retired_at, retirement_reason, retirement_requested_at, retirement_next_attempt_at, created_at, updated_at, credential_keyset_commitment, saved_at, holder_removed_at FROM _keep_wallet_provider_instances;
INSERT INTO wallet_provider_instance_operations SELECT * FROM _keep_wallet_provider_instance_operations;
INSERT INTO wallet_provider_offer_refs SELECT * FROM _keep_wallet_provider_offer_refs;
INSERT INTO wallet_provider_callback_events SELECT * FROM _keep_wallet_provider_callback_events;
INSERT INTO wallet_provider_instance_outcomes SELECT * FROM _keep_wallet_provider_instance_outcomes;
INSERT INTO wallet_provider_instance_dirty SELECT * FROM _keep_wallet_provider_instance_dirty;
INSERT INTO wallet_samsung_fetch_refs SELECT * FROM _keep_wallet_samsung_fetch_refs;
INSERT INTO wallet_samsung_callback_receipts SELECT * FROM _keep_wallet_samsung_callback_receipts;
INSERT INTO wallet_samsung_country_hints SELECT * FROM _keep_wallet_samsung_country_hints;
INSERT INTO wallet_provider_sync_targets SELECT * FROM _keep_wallet_provider_sync_targets;
INSERT INTO wallet_google_callback_bindings SELECT * FROM _keep_wallet_google_callback_bindings;
INSERT INTO wallet_google_callback_receipts SELECT * FROM _keep_wallet_google_callback_receipts;
DROP TABLE _keep_wallet_google_callback_receipts;
DROP TABLE _keep_wallet_google_callback_bindings;
DROP TABLE _keep_wallet_provider_sync_targets;
DROP TABLE _keep_wallet_samsung_country_hints;
DROP TABLE _keep_wallet_samsung_callback_receipts;
DROP TABLE _keep_wallet_samsung_fetch_refs;
DROP TABLE _keep_wallet_provider_instance_dirty;
DROP TABLE _keep_wallet_provider_instance_outcomes;
DROP TABLE _keep_wallet_provider_callback_events;
DROP TABLE _keep_wallet_provider_offer_refs;
DROP TABLE _keep_wallet_provider_instance_operations;
DROP TABLE _keep_wallet_provider_instances;
CREATE UNIQUE INDEX wallet_provider_instances_one_active ON wallet_provider_instances(pass_id, provider) WHERE lifecycle NOT IN ('blocked', 'retired')
  AND NOT (lifecycle = 'revoked' AND retirement_cause IS NOT NULL);
CREATE INDEX wallet_provider_instances_scope ON wallet_provider_instances(org_id, mode, provider, pass_id);
CREATE INDEX wallet_provider_instances_retirement_due ON wallet_provider_instances(lifecycle, retirement_next_attempt_at, id);
CREATE INDEX wallet_provider_instances_account_fk ON wallet_provider_instances(account_id);
CREATE INDEX wallet_provider_instances_projection_fk ON wallet_provider_instances(identity_projection_release_id);
CREATE TRIGGER wallet_provider_instances_identity_immutable
BEFORE UPDATE OF id, pass_id, org_id, mode, provider, credential_generation, channel_epoch ON wallet_provider_instances
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
CREATE INDEX wallet_provider_offer_refs_expiry ON wallet_provider_offer_refs(expires_at);
CREATE INDEX wallet_provider_offer_refs_instance_fk ON wallet_provider_offer_refs(instance_id);
CREATE INDEX wallet_provider_callback_events_instance ON wallet_provider_callback_events(instance_id, received_at);
CREATE INDEX wallet_provider_instance_dirty_due ON wallet_provider_instance_dirty(next_attempt_at, instance_id);
CREATE INDEX wallet_samsung_fetch_refs_instance ON wallet_samsung_fetch_refs(instance_id);
CREATE UNIQUE INDEX wallet_samsung_fetch_refs_one_active ON wallet_samsung_fetch_refs(instance_id) WHERE retired_at IS NULL;
CREATE TRIGGER wallet_samsung_fetch_ref_no_tombstone_reuse BEFORE INSERT ON wallet_samsung_fetch_refs
WHEN EXISTS (SELECT 1 FROM wallet_samsung_tombstones t WHERE t.ref_hash = NEW.ref_hash)
BEGIN SELECT RAISE(ABORT, 'retired Samsung reference cannot be reused'); END;
CREATE INDEX wallet_samsung_callback_receipts_instance ON wallet_samsung_callback_receipts(instance_id, received_at);
CREATE INDEX wallet_samsung_callback_receipts_ref_fk ON wallet_samsung_callback_receipts(ref_id);
CREATE INDEX wallet_samsung_callback_receipts_account_fk ON wallet_samsung_callback_receipts(account_id);
CREATE INDEX wallet_samsung_callback_receipts_org_fk ON wallet_samsung_callback_receipts(org_id);
CREATE INDEX wallet_provider_sync_targets_due ON wallet_provider_sync_targets(state, next_attempt_at);
CREATE INDEX wallet_google_callback_bindings_lookup ON wallet_google_callback_bindings(account_id, class_id_hash, object_id_hash);
CREATE INDEX wallet_google_callback_receipts_instance ON wallet_google_callback_receipts(instance_id, received_at);
CREATE INDEX wallet_google_callback_receipts_org_fk ON wallet_google_callback_receipts(org_id);
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
CREATE TRIGGER wallet_provider_generation_insert_guard BEFORE INSERT ON wallet_provider_instances
WHEN NEW.channel_epoch = 1 AND (NEW.lifecycle != 'blocked' OR NEW.retirement_requested_at IS NOT NULL
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
)
BEGIN SELECT RAISE(ABORT, 'provider issuance is unavailable'); END;
CREATE TRIGGER wallet_provider_generation_binding_guard BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle = 'ready' AND NEW.lifecycle = 'active'
BEGIN SELECT RAISE(ABORT, 'provider issuance is unavailable'); END;
CREATE TRIGGER wallet_provider_generation_no_reblock BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle = 'ready' AND NEW.lifecycle = 'blocked'
BEGIN SELECT RAISE(ABORT, 'provider generation cannot be reblocked'); END;
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
CREATE TRIGGER wallet_provider_instance_delete_settled BEFORE DELETE ON wallet_provider_instances
WHEN NOT EXISTS (SELECT 1 FROM wallet_provider_retirement_complete done WHERE done.id = OLD.id)
  OR EXISTS (SELECT 1 FROM passes p WHERE p.id = OLD.pass_id
    AND (p.org_id != OLD.org_id OR p.mode != OLD.mode))
BEGIN SELECT RAISE(ABORT, 'provider retirement incomplete'); END;
CREATE TRIGGER wallet_provider_instance_no_replace BEFORE INSERT ON wallet_provider_instances
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances existing WHERE existing.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'provider instance identity is immutable'); END;
CREATE TRIGGER wallet_provider_operation_history_delete BEFORE DELETE ON wallet_provider_instance_operations
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = OLD.instance_id)
BEGIN SELECT RAISE(ABORT, 'provider operation history is retained'); END;
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
CREATE TRIGGER wallet_provider_samsung_ref_history_delete BEFORE DELETE ON wallet_samsung_fetch_refs
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.id = OLD.instance_id)
BEGIN SELECT RAISE(ABORT, 'Samsung reference history is retained'); END;
CREATE TRIGGER wallet_provider_samsung_ref_retirement_immutable BEFORE UPDATE OF retired_at ON wallet_samsung_fetch_refs
WHEN OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at
BEGIN SELECT RAISE(ABORT, 'Samsung reference retirement is immutable'); END;
CREATE TRIGGER wallet_provider_generation_ready_guard BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle = 'blocked' AND NEW.lifecycle = 'ready'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM passes p JOIN pass_credential_transfers t ON t.pass_id = p.id
    JOIN wallet_provider_unissued_placeholder empty ON empty.id = OLD.id
    JOIN credential_ref_keyset keyset ON keyset.id = 1 AND keyset.commitment = OLD.credential_keyset_commitment
    WHERE p.id = OLD.pass_id AND p.org_id = OLD.org_id AND p.mode = OLD.mode
      AND p.credential_generation = OLD.credential_generation AND OLD.retirement_requested_at IS NULL
      AND t.org_id = p.org_id AND t.mode = p.mode AND t.target_generation = OLD.credential_generation
      AND t.state = 'completed'
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers pending
        WHERE pending.pass_id = p.id AND pending.state = 'pending')
  ) THEN RAISE(ABORT, 'provider generation is blocked') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM passes p JOIN wallet_provider_instances previous ON previous.pass_id = p.id
    WHERE p.id = OLD.pass_id AND previous.credential_generation < OLD.credential_generation
      AND (previous.org_id != p.org_id OR previous.mode != p.mode
        OR NOT EXISTS (SELECT 1 FROM wallet_provider_retirement_complete done WHERE done.id = previous.id))
  ) THEN RAISE(ABORT, 'provider generation is blocked') END;
END;
CREATE UNIQUE INDEX wallet_samsung_callback_receipts_delivery
  ON wallet_samsung_callback_receipts(token_hash, request_id) WHERE token_hash IS NOT NULL;
CREATE TRIGGER wallet_samsung_ref_promotion_once
BEFORE UPDATE OF promoted_at, market_cc2, market_query_bound, served_at ON wallet_samsung_fetch_refs
WHEN (OLD.promoted_at IS NOT NULL AND (NEW.promoted_at IS NOT OLD.promoted_at
    OR NEW.market_cc2 IS NOT OLD.market_cc2 OR NEW.market_query_bound IS NOT OLD.market_query_bound))
  OR (OLD.promoted_at IS NULL AND NEW.promoted_at IS NOT NULL
    AND (OLD.retired_at IS NOT NULL OR NEW.retired_at IS NOT NULL
      OR NEW.market_cc2 IS NULL OR NEW.market_query_bound IS NULL))
  OR (OLD.promoted_at IS NULL AND NEW.promoted_at IS NULL
    AND (NEW.market_cc2 IS NOT OLD.market_cc2 OR NEW.market_query_bound IS NOT OLD.market_query_bound))
  OR (OLD.served_at IS NOT NULL AND NEW.served_at IS NOT OLD.served_at)
BEGIN SELECT RAISE(ABORT, 'Samsung reference promotion is immutable'); END;
CREATE INDEX wallet_provider_operations_credential_version ON wallet_provider_instance_operations(credential_version_id);
CREATE INDEX wallet_samsung_fetch_refs_credential_version ON wallet_samsung_fetch_refs(credential_version_id);
CREATE TRIGGER wallet_provider_operation_credential_pin BEFORE INSERT ON wallet_provider_instance_operations
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances x WHERE x.id = NEW.instance_id AND x.account_id IS NOT NULL)
  AND NOT EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_accounts a ON a.id = i.account_id
  WHERE i.id = NEW.instance_id AND ((NEW.credential_version_id IS NULL AND a.credential_source_id IS NULL)
    OR EXISTS (SELECT 1 FROM wallet_credential_versions v WHERE v.id = NEW.credential_version_id
      AND v.credential_id = a.credential_source_id)))
BEGIN SELECT RAISE(ABORT, 'wallet credential pin must belong to the enrolment source'); END;
CREATE TRIGGER wallet_samsung_ref_credential_pin BEFORE INSERT ON wallet_samsung_fetch_refs
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances x WHERE x.id = NEW.instance_id AND x.account_id IS NOT NULL)
  AND NOT EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_accounts a ON a.id = i.account_id
  WHERE i.id = NEW.instance_id AND ((NEW.credential_version_id IS NULL AND a.credential_source_id IS NULL)
    OR EXISTS (SELECT 1 FROM wallet_credential_versions v WHERE v.id = NEW.credential_version_id
      AND v.credential_id = a.credential_source_id)))
BEGIN SELECT RAISE(ABORT, 'wallet credential pin must belong to the enrolment source'); END;
CREATE TRIGGER wallet_provider_operation_credential_version_immutable
BEFORE UPDATE OF credential_version_id, instance_id ON wallet_provider_instance_operations
WHEN NEW.credential_version_id IS NOT OLD.credential_version_id OR NEW.instance_id IS NOT OLD.instance_id
BEGIN SELECT RAISE(ABORT, 'wallet credential pin is immutable'); END;
CREATE TRIGGER wallet_samsung_ref_credential_version_immutable
BEFORE UPDATE OF credential_version_id ON wallet_samsung_fetch_refs
WHEN NEW.credential_version_id IS NOT OLD.credential_version_id
BEGIN SELECT RAISE(ABORT, 'wallet credential pin is immutable'); END;
-- rebuild:end

-- A channel turned off retires the provider copy through the same fences as any retirement: the cause is set
-- once, in the UPDATE that requests the retirement, while the pass's marker is retired.
CREATE TRIGGER wallet_provider_instances_channel_off BEFORE UPDATE OF retirement_cause ON wallet_provider_instances
WHEN NEW.retirement_cause IS NOT OLD.retirement_cause AND NOT (
  OLD.retirement_cause IS NULL AND NEW.retirement_cause = 'channel_off'
  AND OLD.retirement_requested_at IS NULL AND NEW.retirement_requested_at IS NOT NULL
  AND NEW.lifecycle IN ('active', 'revoking', 'revoked')
  AND EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode
    AND p.credential_generation = NEW.credential_generation)
  AND EXISTS (SELECT 1 FROM pass_channels c WHERE c.pass_id = NEW.pass_id AND c.org_id = NEW.org_id
    AND c.mode = NEW.mode AND c.channel = NEW.provider AND c.retired_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider channel retirement is not allowed'); END;

-- A successor (epoch > 1) is born active, and only after its predecessor's revoke has settled with nothing
-- in flight and while the channel is on. Epoch 1 rows keep the 0043 insert guard above.
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
      AND a.provider = NEW.provider AND a.credential_id IS NOT NULL AND a.revoked_at IS NULL
      AND (a.credential_source_id IS NULL OR (a.enabled_at IS NOT NULL AND a.platform_hold_at IS NULL))
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

-- Retiring a marker is the intent. The instance is marked dirty in the same statement, so the reconciler
-- stages the revoke even when the writer crashes right after (the pass, template and capability paths share it).
CREATE TRIGGER pass_channels_provider_dirty_insert AFTER INSERT ON pass_channels
WHEN NEW.channel IN ('google', 'samsung') AND NEW.retired_at IS NOT NULL
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT i.id, 1 FROM wallet_provider_instances i
  WHERE i.pass_id = NEW.pass_id AND i.org_id = NEW.org_id AND i.mode = NEW.mode AND i.provider = NEW.channel
    AND i.lifecycle IN ('active', 'revoking', 'revoked') AND i.retirement_requested_at IS NULL
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;
CREATE TRIGGER pass_channels_provider_dirty_update AFTER UPDATE OF retired_at ON pass_channels
WHEN NEW.channel IN ('google', 'samsung') AND NEW.retired_at IS NOT NULL
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT i.id, 1 FROM wallet_provider_instances i
  WHERE i.pass_id = NEW.pass_id AND i.org_id = NEW.org_id AND i.mode = NEW.mode AND i.provider = NEW.channel
    AND i.lifecycle IN ('active', 'revoking', 'revoked') AND i.retirement_requested_at IS NULL
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;

-- One channel-apply run per (org, mode, template) is pending and one running; a save joins the pending row.
CREATE TABLE channel_apply_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'dropped', 'failed')),
  from_channels TEXT NOT NULL CHECK (json_valid(from_channels)),
  from_revision INTEGER NOT NULL,
  to_channels TEXT CHECK (to_channels IS NULL OR json_valid(to_channels)),
  to_revision INTEGER,
  replace_channels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(replace_channels)),
  requested_by TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  cursor TEXT,
  counts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counts)),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  CHECK ((state IN ('pending', 'dropped')) = (to_channels IS NULL) OR state = 'failed')
);
CREATE UNIQUE INDEX channel_apply_runs_pending ON channel_apply_runs(org_id, mode, template_id) WHERE state = 'pending';
CREATE UNIQUE INDEX channel_apply_runs_running ON channel_apply_runs(org_id, mode, template_id) WHERE state = 'running';
CREATE INDEX channel_apply_runs_due ON channel_apply_runs(due_at) WHERE state IN ('pending', 'running');
CREATE INDEX channel_apply_runs_template ON channel_apply_runs(template_id);
CREATE TRIGGER channel_apply_runs_tenant BEFORE INSERT ON channel_apply_runs
WHEN NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = NEW.template_id AND t.org_id = NEW.org_id)
BEGIN SELECT RAISE(ABORT, 'channel apply run tenant mismatch'); END;
CREATE TRIGGER channel_apply_runs_insert BEFORE INSERT ON channel_apply_runs
WHEN NEW.state != 'pending'
BEGIN SELECT RAISE(ABORT, 'channel apply run must start pending'); END;
CREATE TRIGGER channel_apply_runs_key BEFORE UPDATE ON channel_apply_runs
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
  OR NEW.template_id IS NOT OLD.template_id OR NEW.from_channels IS NOT OLD.from_channels
  OR NEW.from_revision IS NOT OLD.from_revision OR NEW.requested_by IS NOT OLD.requested_by
BEGIN SELECT RAISE(ABORT, 'channel apply run key is immutable'); END;
CREATE TRIGGER channel_apply_runs_state BEFORE UPDATE ON channel_apply_runs
WHEN OLD.state IN ('done', 'dropped', 'failed')
  OR (NEW.replace_channels IS NOT OLD.replace_channels AND OLD.state != 'pending')
  OR (NEW.state IS NOT OLD.state AND NOT (
    (OLD.state = 'pending' AND NEW.state IN ('running', 'dropped', 'failed'))
    OR (OLD.state = 'running' AND NEW.state IN ('done', 'failed'))))
  OR ((NEW.to_channels IS NOT OLD.to_channels OR NEW.to_revision IS NOT OLD.to_revision)
    AND NOT (OLD.state = 'pending' AND NEW.state = 'running'))
BEGIN SELECT RAISE(ABORT, 'invalid channel apply run transition'); END;

-- A page's evidence per pass: the journal and the holder notice each move once, NULL to a value.
CREATE TABLE channel_apply_marks (
  run_id TEXT NOT NULL REFERENCES channel_apply_runs(id) ON DELETE CASCADE,
  pass_id TEXT NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
  events TEXT NOT NULL CHECK (json_valid(events)),
  journaled_at INTEGER,
  notice_at INTEGER,
  PRIMARY KEY (run_id, pass_id)
) WITHOUT ROWID;
CREATE INDEX channel_apply_marks_pass ON channel_apply_marks(pass_id);
CREATE TRIGGER channel_apply_marks_tenant BEFORE INSERT ON channel_apply_marks
WHEN NOT EXISTS (SELECT 1 FROM channel_apply_runs r JOIN passes p ON p.id = NEW.pass_id
  WHERE r.id = NEW.run_id AND p.org_id = r.org_id AND p.mode = r.mode AND p.template_id = r.template_id)
BEGIN SELECT RAISE(ABORT, 'channel apply mark tenant mismatch'); END;
CREATE TRIGGER channel_apply_marks_once BEFORE UPDATE ON channel_apply_marks
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.pass_id IS NOT OLD.pass_id OR NEW.events IS NOT OLD.events
  OR (NEW.journaled_at IS NOT OLD.journaled_at AND OLD.journaled_at IS NOT NULL)
  OR (NEW.notice_at IS NOT OLD.notice_at AND OLD.notice_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'channel apply mark is write-once'); END;

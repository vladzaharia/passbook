-- An issuance email is created with the pass, not after the issuing request returns.
-- The source is immutable; only a single verified attach may advance it to a new incarnation.
-- Authority is the grant plus lineage (generations, recipient, owner); content is read at send time,
-- so no version, revision, secret or release snapshot is kept. The object keys only hold the stored
-- objects against garbage collection (0048).
CREATE TABLE pass_issuance_deliveries (
  pass_id TEXT NOT NULL PRIMARY KEY REFERENCES passes(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  recipient TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  source_owner_user_id TEXT,
  source_generation INTEGER NOT NULL,
  source_lifecycle_generation INTEGER NOT NULL,
  source_link_generation INTEGER NOT NULL,
  source_object_key TEXT NOT NULL,
  template_id TEXT NOT NULL,
  connection_id TEXT,
  connection_ref TEXT,
  connection_generation INTEGER,
  context TEXT NOT NULL CHECK (json_valid(context)),
  transfer_id TEXT REFERENCES pass_credential_transfers(id),
  target_object_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'cancelled')),
  outbox_id TEXT UNIQUE,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('sent', 'partial', 'failed', 'cancelled')),
  error_code TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK ((state = 'queued' AND outbox_id IS NOT NULL) OR
         (state IN ('pending', 'cancelled') AND outbox_id IS NULL))
);
CREATE INDEX pass_issuance_deliveries_due
  ON pass_issuance_deliveries(state, next_attempt_at, created_at);
CREATE INDEX pass_issuance_deliveries_transfer ON pass_issuance_deliveries(transfer_id);
-- A replace cannot erase a prior delivery or synthesize a fresh attempt.
CREATE TRIGGER pass_issuance_delivery_insert_guard
BEFORE INSERT ON pass_issuance_deliveries
WHEN NEW.state != 'pending' OR NEW.transfer_id IS NOT NULL OR NEW.outbox_id IS NOT NULL OR NEW.outcome IS NOT NULL
  OR NEW.target_object_key IS NOT NULL
  OR EXISTS (SELECT 1 FROM pass_issuance_deliveries i WHERE i.pass_id = NEW.pass_id)
  OR NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id
    AND p.mode = NEW.mode AND p.holder_email = NEW.recipient AND p.owner_user_id IS NEW.source_owner_user_id
    AND p.identity_id = NEW.identity_id AND p.credential_generation = NEW.source_generation
    AND p.lifecycle_generation = NEW.source_lifecycle_generation
    AND p.link_generation = NEW.source_link_generation AND p.object_key = NEW.source_object_key
    AND p.template_id = NEW.template_id AND p.connection_id IS NEW.connection_id
    AND p.external_ref IS NEW.connection_ref AND p.status = 'active' AND p.removed_at IS NULL
    AND p.deleted_at IS NULL AND p.test_data_quarantined = 0)
BEGIN SELECT RAISE(ABORT, 'invalid issuance delivery source'); END;
CREATE TRIGGER pass_issuance_delivery_transfer_guard
BEFORE UPDATE OF transfer_id ON pass_issuance_deliveries
WHEN NEW.transfer_id IS NOT OLD.transfer_id AND NOT (
  OLD.transfer_id IS NULL AND NEW.transfer_id IS NOT NULL AND NEW.state = 'pending'
  AND OLD.source_owner_user_id IS NULL
  AND EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.id = NEW.transfer_id
    AND t.pass_id = OLD.pass_id AND t.org_id = OLD.org_id AND t.mode = OLD.mode AND t.state = 'pending'
    AND t.source_generation = OLD.source_generation
    AND t.source_lifecycle_generation = OLD.source_lifecycle_generation
    AND t.source_link_generation = OLD.source_link_generation + 1
    AND t.target_holder_email = OLD.recipient AND t.target_owner_user_id IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'invalid issuance delivery transfer'); END;
CREATE TRIGGER pass_issuance_delivery_state_guard
BEFORE UPDATE OF state, outbox_id ON pass_issuance_deliveries
WHEN (NEW.state IS NOT OLD.state OR NEW.outbox_id IS NOT OLD.outbox_id) AND NOT (
  (OLD.state = 'pending' AND NEW.state = 'cancelled' AND NEW.outbox_id IS NULL)
  OR (OLD.state = 'pending' AND NEW.state = 'queued' AND OLD.outbox_id IS NULL
    AND EXISTS (SELECT 1 FROM outbox ob WHERE ob.id = NEW.outbox_id AND ob.kind = 'email'
      AND ob.state = 'pending' AND ob.pass_id = OLD.pass_id AND ob.org_id = OLD.org_id
      AND json_extract(ob.payload, '$.intent.issuanceId') = OLD.pass_id))
  OR (OLD.state = 'queued' AND NEW.state IN ('pending', 'cancelled') AND NEW.outbox_id IS NULL
    AND EXISTS (SELECT 1 FROM outbox ob WHERE ob.id = OLD.outbox_id
      AND ob.state = 'cancelled' AND ob.error_code = 'TRANSFER_SUPERSEDED'))
)
BEGIN SELECT RAISE(ABORT, 'invalid issuance delivery transition'); END;
CREATE TRIGGER pass_issuance_delivery_outcome_guard
BEFORE UPDATE OF outcome ON pass_issuance_deliveries
WHEN NEW.outcome IS NOT OLD.outcome AND NOT EXISTS (
  SELECT 1 FROM outbox ob WHERE ob.id = OLD.outbox_id AND ob.kind = 'email'
    AND ob.pass_id = OLD.pass_id AND ob.org_id = OLD.org_id AND ob.state = NEW.outcome
    AND ob.state IN ('sent', 'partial', 'failed', 'cancelled'))
BEGIN SELECT RAISE(ABORT, 'invalid issuance delivery outcome'); END;
CREATE TRIGGER pass_issuance_delivery_source_immutable
BEFORE UPDATE OF pass_id, org_id, mode, recipient, identity_id, source_owner_user_id,
  source_generation, source_lifecycle_generation, source_link_generation, source_object_key,
  template_id, connection_id, connection_ref, connection_generation, context, created_at
ON pass_issuance_deliveries
BEGIN SELECT RAISE(ABORT, 'issuance delivery source is immutable'); END;
-- The target object key is captured once, after the transfer's artifact commit, in the same transaction.
CREATE TRIGGER pass_issuance_delivery_target_once
BEFORE UPDATE OF target_object_key ON pass_issuance_deliveries
WHEN OLD.target_object_key IS NOT NULL OR NEW.target_object_key IS NULL
  OR NEW.transfer_id IS NULL OR NEW.state != 'pending'
  OR NOT EXISTS (SELECT 1 FROM pass_credential_transfers t JOIN passes p ON p.id = t.pass_id
    WHERE t.id = NEW.transfer_id AND t.pass_id = NEW.pass_id AND t.state = 'completed'
      AND p.object_key = NEW.target_object_key)
BEGIN SELECT RAISE(ABORT, 'issuance delivery target is immutable'); END;

-- The outcome follows the outbox row.
CREATE TRIGGER pass_issuance_delivery_clear_finished
AFTER UPDATE OF state ON outbox
WHEN NEW.kind = 'email' AND NEW.state IN ('sent', 'partial', 'failed', 'cancelled')
  AND NEW.error_code IS NOT 'TRANSFER_SUPERSEDED'
BEGIN
  UPDATE pass_issuance_deliveries SET outcome = NEW.state,
    error_code = CASE WHEN NEW.state = 'sent' THEN NULL ELSE NEW.error_code END
  WHERE outbox_id = NEW.id AND state = 'queued';
END;

-- Publication and refresh pushes use the same incarnation-specific coalescing key and payload.
-- A replacement artifact's push is committed with the transfer and held until it completes.
DROP TRIGGER pass_published;
CREATE TRIGGER pass_published
AFTER UPDATE OF object_key ON passes
WHEN NEW.object_key != OLD.object_key
BEGIN
  INSERT INTO revisions (pass_id, at) VALUES (NEW.id, NEW.modified_at);
  UPDATE passes
    SET revision = last_insert_rowid(), pending_pass_json = NULL, pending_cause = 'admin',
        pending_actor_type = NULL, pending_actor_id = NULL, pending_source = NULL
    WHERE id = NEW.id;
  INSERT INTO pass_versions (pass_id, version, object_key, object_sha256, template_version,
                             personalization, pass_json, cause, source, actor_type, actor_id, created_at)
    VALUES (NEW.id, NEW.version, NEW.object_key, NEW.object_sha256, NEW.template_version,
            NEW.personalization, NEW.pending_pass_json, NEW.pending_cause, NEW.pending_source,
            NEW.pending_actor_type, NEW.pending_actor_id, NEW.modified_at);
  -- g is the lifecycle generation after pass_lifecycle_authority_changed (0042) runs on the same
  -- UPDATE: NEW holds the pre-bump value whichever trigger fires first. Keep its WHEN in step.
  INSERT OR IGNORE INTO outbox
    (id, org_id, kind, pass_id, coalesce_key, payload, state, available_at, created_at)
    SELECT 'push:' || NEW.id || ':' || NEW.version, NEW.org_id, 'push', NEW.id,
      'push:' || json_array(NEW.id, NEW.identity_id, NEW.credential_generation, v.g,
        NEW.template_id, NEW.template_version, NEW.release_id),
      json_object('reason', 'publish', 'identityId', NEW.identity_id,
        'credentialGeneration', NEW.credential_generation, 'lifecycleGeneration', v.g,
        'templateId', NEW.template_id, 'templateVersion', NEW.template_version, 'releaseId', NEW.release_id),
      'pending', 0, NEW.modified_at
    FROM (SELECT NEW.lifecycle_generation + CASE
        WHEN NEW.lifecycle_generation = OLD.lifecycle_generation
          AND (NEW.deleted_at IS NOT OLD.deleted_at
            OR NEW.test_data_quarantined IS NOT OLD.test_data_quarantined
            OR NEW.removed_at IS NOT OLD.removed_at
            OR (NEW.status IS NOT OLD.status AND NEW.removed_at IS NULL))
        THEN 1 ELSE 0 END AS g) v
    WHERE NEW.pending_cause != 'resign';
END;

-- Cutover backfill (populated 0024 database): a push queued before this migration carries no
-- binding, and deliverPush cancels it as PASS_GONE. Bind it to the pass's current state.
-- OR IGNORE leaves a row whose new coalesce_key already exists; delivery cancels that duplicate.
UPDATE OR IGNORE outbox
SET payload = (SELECT json_set(outbox.payload,
      '$.reason', COALESCE(json_extract(outbox.payload, '$.reason'), 'publish'),
      '$.identityId', p.identity_id, '$.credentialGeneration', p.credential_generation,
      '$.lifecycleGeneration', p.lifecycle_generation, '$.templateId', p.template_id,
      '$.templateVersion', p.template_version, '$.releaseId', p.release_id)
    FROM passes p WHERE p.id = outbox.pass_id),
  coalesce_key = (SELECT 'push:' || json_array(p.id, p.identity_id, p.credential_generation,
      p.lifecycle_generation, p.template_id, p.template_version, p.release_id)
    FROM passes p WHERE p.id = outbox.pass_id)
WHERE kind = 'push' AND state IN ('pending', 'enqueued') AND pass_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM passes p WHERE p.id = outbox.pass_id);

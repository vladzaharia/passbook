-- passes module: soft delete, content hash, asset CRC, unique connection refs, purge index.

ALTER TABLE passes ADD COLUMN deleted_at INTEGER;
ALTER TABLE passes ADD COLUMN content_hash TEXT;
ALTER TABLE pass_assets ADD COLUMN crc32 INTEGER;

CREATE INDEX passes_deleted ON passes (deleted_at) WHERE deleted_at IS NOT NULL;

-- Keep the oldest pass per ref; unlink later duplicates so the unique index can be created.
UPDATE passes SET connection_id = NULL, external_ref = NULL
WHERE connection_id IS NOT NULL AND external_ref IS NOT NULL AND EXISTS (
  SELECT 1 FROM passes q
  WHERE q.org_id = passes.org_id AND q.connection_id = passes.connection_id
    AND q.external_ref = passes.external_ref AND q.id < passes.id);
CREATE UNIQUE INDEX passes_connection_ref_unique ON passes (org_id, connection_id, external_ref)
  WHERE connection_id IS NOT NULL AND external_ref IS NOT NULL;

-- Purged versions no longer keep holder data.
UPDATE pass_versions SET personalization = '{}' WHERE purged_at IS NOT NULL;
CREATE INDEX pass_versions_unpurged ON pass_versions (pass_id, version) WHERE purged_at IS NULL;

-- A forced re-sign publishes a new object but does not push: installed passes keep working.
DROP TRIGGER pass_published;
CREATE TRIGGER pass_published
AFTER UPDATE OF object_key ON passes
WHEN NEW.object_key != OLD.object_key
BEGIN
  INSERT INTO revisions (pass_id, at) VALUES (NEW.id, NEW.modified_at);
  UPDATE passes
    SET revision = last_insert_rowid(), pending_pass_json = NULL, pending_cause = 'admin',
        pending_actor_type = NULL, pending_actor_id = NULL
    WHERE id = NEW.id;
  INSERT INTO pass_versions (pass_id, version, object_key, object_sha256, template_version,
                             personalization, pass_json, cause, actor_type, actor_id, created_at)
    VALUES (NEW.id, NEW.version, NEW.object_key, NEW.object_sha256, NEW.template_version,
            NEW.personalization, NEW.pending_pass_json, NEW.pending_cause,
            NEW.pending_actor_type, NEW.pending_actor_id, NEW.modified_at);
  INSERT OR IGNORE INTO outbox (id, org_id, kind, pass_id, coalesce_key, state, available_at, created_at)
    SELECT 'push:' || NEW.id || ':' || NEW.version, NEW.org_id, 'push', NEW.id,
           'push:' || NEW.id, 'pending', 0, NEW.modified_at
    WHERE NEW.pending_cause != 'resign';
END;

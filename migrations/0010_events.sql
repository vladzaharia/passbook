-- Event ledger, sandbox mode, scan codes.

CREATE TABLE pass_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test')),
  -- A closed list, validated by the app (src/shared/contracts/events.ts), so a new kind needs no migration.
  kind TEXT NOT NULL,
  -- First 12 hex characters of SHA-256(device id); never the device id.
  device TEXT,
  actor_type TEXT,
  actor_id TEXT,
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  at INTEGER NOT NULL
);
CREATE INDEX pass_events_pass ON pass_events (pass_id, at DESC);
CREATE INDEX pass_events_org_kind ON pass_events (org_id, kind, at DESC);
CREATE INDEX pass_events_at ON pass_events (at);

-- passes is referenced by many tables: columns are added, never rebuilt.
ALTER TABLE passes ADD COLUMN mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test'));
-- SHA-256 hex of the primary barcode message, written on every publish.
ALTER TABLE passes ADD COLUMN barcode_hash TEXT;
-- 128-bit base32, created with the pass; older passes get one on their next publish.
ALTER TABLE passes ADD COLUMN scan_code TEXT;
ALTER TABLE passes ADD COLUMN removed_at INTEGER;
-- Consumed by the publish triggers like pending_cause.
ALTER TABLE passes ADD COLUMN pending_source TEXT;
CREATE INDEX passes_barcode_hash ON passes (org_id, barcode_hash) WHERE barcode_hash IS NOT NULL;
CREATE UNIQUE INDEX passes_scan_code ON passes (scan_code) WHERE scan_code IS NOT NULL;
CREATE INDEX passes_org_mode ON passes (org_id, mode, id DESC);

-- Free text, validated in the app: scan, broadcast, schedule, remove, restore, designer.
ALTER TABLE pass_versions ADD COLUMN source TEXT;

ALTER TABLE api_keys ADD COLUMN mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test'));

-- The publish triggers copy pending_source next to pending_cause and reset it.
DROP TRIGGER pass_created;
CREATE TRIGGER pass_created
AFTER INSERT ON passes
BEGIN
  INSERT INTO revisions (pass_id, at) VALUES (NEW.id, NEW.modified_at);
  UPDATE passes
    SET revision = last_insert_rowid(), pending_pass_json = NULL, pending_cause = 'admin',
        pending_actor_type = NULL, pending_actor_id = NULL, pending_source = NULL
    WHERE id = NEW.id;
  INSERT INTO pass_versions (pass_id, version, object_key, object_sha256, template_version,
                             personalization, pass_json, cause, source, actor_type, actor_id, created_at)
    VALUES (NEW.id, NEW.version, NEW.object_key, NEW.object_sha256, NEW.template_version,
            NEW.personalization, NEW.pending_pass_json,
            'create', NEW.pending_source,
            NEW.pending_actor_type, NEW.pending_actor_id, NEW.modified_at);
END;

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
  INSERT OR IGNORE INTO outbox (id, org_id, kind, pass_id, coalesce_key, state, available_at, created_at)
    SELECT 'push:' || NEW.id || ':' || NEW.version, NEW.org_id, 'push', NEW.id,
           'push:' || NEW.id, 'pending', 0, NEW.modified_at
    -- A forced re-sign publishes a new object but does not push.
    WHERE NEW.pending_cause != 'resign';
END;

-- Nothing references workflow_runs, so its kind list can grow by a rebuild.
CREATE TABLE workflow_runs_new (
  instance_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('template_import', 'bulk_reissue', 'connection_sync', 'broadcast')),
  org_id TEXT,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'errored', 'terminated')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_code TEXT
);
INSERT INTO workflow_runs_new SELECT instance_id, kind, org_id, target_id, status, started_at, finished_at, error_code
  FROM workflow_runs;
DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_new RENAME TO workflow_runs;
CREATE INDEX workflow_runs_kind ON workflow_runs (kind, started_at DESC);
CREATE INDEX workflow_runs_target ON workflow_runs (target_id, started_at DESC);

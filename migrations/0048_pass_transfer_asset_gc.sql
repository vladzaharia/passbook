-- A row snapshot alone cannot distinguish A -> B -> A. Every image mutation, including an
-- exact compensation or a direct SQL write, advances this independent monotonic epoch.
ALTER TABLE passes ADD COLUMN image_generation INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(image_generation) = 'integer' AND image_generation BETWEEN 0 AND 9007199254740991);
CREATE TRIGGER passes_image_generation_monotonic BEFORE UPDATE OF image_generation ON passes
WHEN NEW.image_generation < OLD.image_generation
BEGIN SELECT RAISE(ABORT, 'image generation cannot go backwards'); END;
CREATE TRIGGER pass_assets_image_generation_insert AFTER INSERT ON pass_assets
BEGIN UPDATE passes SET image_generation = image_generation + 1 WHERE id = NEW.pass_id; END;
CREATE TRIGGER member_photos_image_generation_insert AFTER INSERT ON member_photos
BEGIN UPDATE passes SET image_generation = image_generation + 1 WHERE id = NEW.pass_id; END;

-- A retired key is a permanent tombstone as well as a durable deletion queue entry.  It is
-- deliberately not a child of a pass or transfer: cascading either must not reopen the key.
CREATE TABLE pass_transfer_asset_gc (
  r2_key TEXT NOT NULL PRIMARY KEY CHECK (length(r2_key) > 0),
  transfer_id TEXT,
  source_pass_id TEXT,
  retired_at INTEGER NOT NULL,
  -- Only these dedicated namespaces can be erased; an unexpected legacy key might name
  -- organization branding, a template or another kind of object, and must be retained.
  deletion_eligible INTEGER GENERATED ALWAYS AS (
    CASE WHEN substr(r2_key, 1, 12) = 'pass-assets/'
           OR substr(r2_key, 1, 14) = 'member-photos/' THEN 1 ELSE 0 END
  ) STORED,
  next_attempt_at INTEGER NOT NULL,
  claim_token TEXT,
  claim_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_deleted_at INTEGER,
  -- A deleted key is checked again a bounded number of times for a late PUT, then settles: the row stays
  -- as the immutable tombstone but leaves the sweep (W1-13).
  rechecks INTEGER NOT NULL DEFAULT 0 CHECK (rechecks >= 0),
  settled_at INTEGER,
  CHECK ((transfer_id IS NULL AND source_pass_id IS NULL) OR
         (transfer_id IS NOT NULL AND source_pass_id IS NOT NULL)),
  CHECK ((claim_token IS NULL AND claim_until IS NULL) OR
         (claim_token IS NOT NULL AND claim_until IS NOT NULL))
);
CREATE INDEX pass_transfer_asset_gc_due ON pass_transfer_asset_gc(next_attempt_at, r2_key)
  WHERE deletion_eligible = 1 AND settled_at IS NULL;
CREATE INDEX pass_assets_r2 ON pass_assets(r2_key);
CREATE INDEX pass_versions_r2 ON pass_versions(object_key) WHERE object_key IS NOT NULL;
CREATE INDEX passes_r2 ON passes(object_key);
CREATE INDEX template_imports_r2 ON template_imports(object_key);
CREATE INDEX template_version_extras_r2 ON template_version_extras(r2_key);
CREATE INDEX pass_issuance_deliveries_source_r2 ON pass_issuance_deliveries(source_object_key);
CREATE INDEX pass_issuance_deliveries_target_r2 ON pass_issuance_deliveries(target_object_key)
  WHERE target_object_key IS NOT NULL;

-- Each detached reference gets its own rollback hold, even when another slot or operation
-- detached the same key.  An operation releases only its own id after publication/compensation.
CREATE TABLE pass_transfer_asset_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id TEXT NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('asset', 'photo')),
  slot TEXT NOT NULL,
  source_credential_generation INTEGER NOT NULL,
  source_lifecycle_generation INTEGER NOT NULL,
  source_version INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  source_image_generation INTEGER NOT NULL,
  prior_row TEXT NOT NULL CHECK (json_valid(prior_row)),
  next_row TEXT CHECK (next_row IS NULL OR json_valid(next_row)),
  created_at INTEGER NOT NULL
);
CREATE INDEX pass_transfer_asset_candidates_pass ON pass_transfer_asset_candidates(pass_id, id);
CREATE INDEX pass_transfer_asset_candidates_r2 ON pass_transfer_asset_candidates(r2_key);
CREATE INDEX pass_transfer_asset_candidates_due ON pass_transfer_asset_candidates(created_at, id);
-- Markers exist only inside a single recovery batch and suppress recursively creating a hold
-- for the recovery's own compensation. A failed/ambiguous batch leaves no partial marker.
CREATE TABLE pass_transfer_asset_recoveries (
  candidate_id INTEGER NOT NULL PRIMARY KEY,
  pass_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  slot TEXT NOT NULL,
  prior_key TEXT NOT NULL,
  next_key TEXT,
  image_generation INTEGER NOT NULL,
  link_generation INTEGER NOT NULL,
  restored INTEGER NOT NULL DEFAULT 0 CHECK (restored IN (0, 1))
);

-- Uploads are reserved while the exact source pass and authority still hold, before R2 PUT.
-- A successful image CAS consumes its reservation in the same SQLite statement; FINISH also
-- retires any source-generation reservation whose PUT or CAS was interrupted.
CREATE TABLE pass_transfer_asset_uploads (
  r2_key TEXT NOT NULL PRIMARY KEY,
  pass_id TEXT NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
  credential_generation INTEGER NOT NULL,
  lifecycle_generation INTEGER NOT NULL,
  link_generation INTEGER NOT NULL,
  pass_version INTEGER NOT NULL,
  pass_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX pass_transfer_asset_uploads_pass ON pass_transfer_asset_uploads(pass_id, credential_generation);
CREATE INDEX pass_transfer_asset_uploads_due ON pass_transfer_asset_uploads(created_at, r2_key);
CREATE TRIGGER pass_transfer_asset_uploads_insert_guard BEFORE INSERT ON pass_transfer_asset_uploads
WHEN EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.r2_key)
  OR EXISTS (SELECT 1 FROM pass_transfer_asset_uploads u WHERE u.r2_key = NEW.r2_key)
  OR NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id
    AND p.credential_generation = NEW.credential_generation
    AND p.lifecycle_generation = NEW.lifecycle_generation AND p.link_generation = NEW.link_generation
    AND p.version = NEW.pass_version AND p.revision = NEW.pass_revision
    AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending'))
  OR EXISTS (SELECT 1 FROM pass_assets a WHERE a.r2_key = NEW.r2_key)
  OR EXISTS (SELECT 1 FROM member_photos m WHERE m.r2_key = NEW.r2_key)
  OR EXISTS (SELECT 1 FROM pass_transfer_asset_candidates c WHERE c.r2_key = NEW.r2_key)
  OR EXISTS (SELECT 1 FROM passes p WHERE p.object_key = NEW.r2_key)
  OR EXISTS (SELECT 1 FROM pass_versions v WHERE v.object_key = NEW.r2_key)
  OR EXISTS (SELECT 1 FROM template_imports i WHERE i.object_key = NEW.r2_key)
  OR EXISTS (SELECT 1 FROM template_version_extras e WHERE e.r2_key = NEW.r2_key)
  OR EXISTS (SELECT 1 FROM template_versions v, json_tree(v.assets) j
    WHERE j.key = 'key' AND j.type = 'text' AND j.value = NEW.r2_key)
  OR EXISTS (SELECT 1 FROM pass_issuance_deliveries i
    WHERE i.source_object_key = NEW.r2_key OR i.target_object_key = NEW.r2_key)
BEGIN SELECT RAISE(ABORT, 'image upload key unavailable'); END;

CREATE TRIGGER pass_assets_capture_detached_update AFTER UPDATE ON pass_assets
BEGIN
  UPDATE passes SET image_generation = image_generation + 1 WHERE id = NEW.pass_id OR id = OLD.pass_id;
  INSERT INTO pass_transfer_asset_candidates
    (pass_id,r2_key,kind,slot,source_credential_generation,source_lifecycle_generation,
     source_version,source_revision,source_image_generation,prior_row,next_row,created_at)
  SELECT p.id, OLD.r2_key, 'asset', OLD.name, p.credential_generation, p.lifecycle_generation,
    p.version, p.revision, p.image_generation,
    json_array(OLD.pass_id,OLD.name,OLD.r2_key,OLD.sha1,OLD.size,OLD.width,OLD.height,OLD.crc32,OLD.created_at),
    json_array(NEW.pass_id,NEW.name,NEW.r2_key,NEW.sha1,NEW.size,NEW.width,NEW.height,NEW.crc32,NEW.created_at),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM passes p WHERE p.id = OLD.pass_id
    AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_recoveries r
      WHERE r.pass_id = OLD.pass_id AND r.kind = 'asset' AND r.slot = OLD.name);
END;
CREATE TRIGGER pass_assets_capture_detached_delete AFTER DELETE ON pass_assets
BEGIN
  UPDATE passes SET image_generation = image_generation + 1 WHERE id = OLD.pass_id;
  INSERT INTO pass_transfer_asset_candidates
    (pass_id,r2_key,kind,slot,source_credential_generation,source_lifecycle_generation,
     source_version,source_revision,source_image_generation,prior_row,next_row,created_at)
  SELECT p.id, OLD.r2_key, 'asset', OLD.name, p.credential_generation, p.lifecycle_generation,
    p.version, p.revision, p.image_generation,
    json_array(OLD.pass_id,OLD.name,OLD.r2_key,OLD.sha1,OLD.size,OLD.width,OLD.height,OLD.crc32,OLD.created_at),
    NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM passes p WHERE p.id = OLD.pass_id
    AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_recoveries r
      WHERE r.pass_id = OLD.pass_id AND r.kind = 'asset' AND r.slot = OLD.name);
END;
CREATE TRIGGER member_photos_capture_detached_update AFTER UPDATE ON member_photos
BEGIN
  UPDATE passes SET image_generation = image_generation + 1 WHERE id = NEW.pass_id OR id = OLD.pass_id;
  INSERT INTO pass_transfer_asset_candidates
    (pass_id,r2_key,kind,slot,source_credential_generation,source_lifecycle_generation,
     source_version,source_revision,source_image_generation,prior_row,next_row,created_at)
  SELECT p.id, OLD.r2_key, 'photo', '', p.credential_generation, p.lifecycle_generation,
    p.version, p.revision, p.image_generation,
    json_array(OLD.pass_id,OLD.org_id,OLD.r2_key,OLD.sha1,OLD.size,OLD.crc32,OLD.include_in_pass,OLD.version,OLD.updated_at),
    json_array(NEW.pass_id,NEW.org_id,NEW.r2_key,NEW.sha1,NEW.size,NEW.crc32,NEW.include_in_pass,NEW.version,NEW.updated_at),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM passes p WHERE p.id = OLD.pass_id
    AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_recoveries r
      WHERE r.pass_id = OLD.pass_id AND r.kind = 'photo');
END;
CREATE TRIGGER member_photos_capture_detached_delete AFTER DELETE ON member_photos
BEGIN
  UPDATE passes SET image_generation = image_generation + 1 WHERE id = OLD.pass_id;
  INSERT INTO pass_transfer_asset_candidates
    (pass_id,r2_key,kind,slot,source_credential_generation,source_lifecycle_generation,
     source_version,source_revision,source_image_generation,prior_row,next_row,created_at)
  SELECT p.id, OLD.r2_key, 'photo', '', p.credential_generation, p.lifecycle_generation,
    p.version, p.revision, p.image_generation,
    json_array(OLD.pass_id,OLD.org_id,OLD.r2_key,OLD.sha1,OLD.size,OLD.crc32,OLD.include_in_pass,OLD.version,OLD.updated_at),
    NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM passes p WHERE p.id = OLD.pass_id
    AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_recoveries r
      WHERE r.pass_id = OLD.pass_id AND r.kind = 'photo');
END;

CREATE TRIGGER pass_assets_consume_upload_insert AFTER INSERT ON pass_assets
BEGIN
  DELETE FROM pass_transfer_asset_uploads WHERE pass_id = NEW.pass_id AND r2_key = NEW.r2_key
    AND credential_generation = (SELECT p.credential_generation FROM passes p WHERE p.id = NEW.pass_id);
END;
CREATE TRIGGER pass_assets_consume_upload_update AFTER UPDATE ON pass_assets
BEGIN
  DELETE FROM pass_transfer_asset_uploads WHERE pass_id = NEW.pass_id AND r2_key = NEW.r2_key
    AND credential_generation = (SELECT p.credential_generation FROM passes p WHERE p.id = NEW.pass_id);
END;
CREATE TRIGGER member_photos_consume_upload_insert AFTER INSERT ON member_photos
BEGIN
  DELETE FROM pass_transfer_asset_uploads WHERE pass_id = NEW.pass_id AND r2_key = NEW.r2_key
    AND credential_generation = (SELECT p.credential_generation FROM passes p WHERE p.id = NEW.pass_id);
END;
CREATE TRIGGER member_photos_consume_upload_update AFTER UPDATE ON member_photos
BEGIN
  DELETE FROM pass_transfer_asset_uploads WHERE pass_id = NEW.pass_id AND r2_key = NEW.r2_key
    AND credential_generation = (SELECT p.credential_generation FROM passes p WHERE p.id = NEW.pass_id);
END;

-- Do not allow REPLACE to silently remove the tombstone, even when recursive triggers are off.
CREATE TRIGGER pass_transfer_asset_gc_insert_once BEFORE INSERT ON pass_transfer_asset_gc
WHEN EXISTS (SELECT 1 FROM pass_transfer_asset_gc old WHERE old.r2_key = NEW.r2_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key is immutable'); END;
CREATE TRIGGER pass_transfer_asset_gc_immutable
BEFORE UPDATE OF r2_key, transfer_id, source_pass_id, retired_at ON pass_transfer_asset_gc
WHEN NEW.r2_key IS NOT OLD.r2_key OR NEW.transfer_id IS NOT OLD.transfer_id
  OR NEW.source_pass_id IS NOT OLD.source_pass_id OR NEW.retired_at IS NOT OLD.retired_at
BEGIN SELECT RAISE(ABORT, 'retired pass asset key is immutable'); END;
CREATE TRIGGER pass_transfer_asset_gc_no_delete BEFORE DELETE ON pass_transfer_asset_gc
BEGIN SELECT RAISE(ABORT, 'retired pass asset key is immutable'); END;

-- Deleting a pass must not cascade away an unfinished upload or rollback hold before its
-- object is durably tracked. Existing references from other records remain protected at claim.
CREATE TRIGGER pass_image_holds_retire_before_delete BEFORE DELETE ON passes
BEGIN
  INSERT INTO pass_transfer_asset_gc
    (r2_key, transfer_id, source_pass_id, retired_at, next_attempt_at)
  SELECT keys.r2_key, NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 0 FROM (
    SELECT r2_key FROM pass_assets WHERE pass_id = OLD.id
    UNION SELECT r2_key FROM member_photos WHERE pass_id = OLD.id
    UNION SELECT r2_key FROM pass_transfer_asset_candidates WHERE pass_id = OLD.id
    UNION SELECT r2_key FROM pass_transfer_asset_uploads WHERE pass_id = OLD.id
  ) keys WHERE NOT EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = keys.r2_key);
END;

-- Existing references shared with other passes remain usable. A detached same-slot candidate
-- also permits its original pass to compensate while it holds the key. The sweeper treats that
-- candidate as a reference, and FINISH removes all of the old holder's holds atomically.
CREATE TRIGGER pass_assets_retired_insert BEFORE INSERT ON pass_assets
WHEN EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.r2_key)
  AND NOT EXISTS (SELECT 1 FROM pass_assets a
    WHERE a.pass_id = NEW.pass_id AND a.name = NEW.name AND a.r2_key = NEW.r2_key)
  AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_candidates c WHERE c.pass_id = NEW.pass_id
    AND c.kind = 'asset' AND c.slot = NEW.name AND c.r2_key = NEW.r2_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;
CREATE TRIGGER pass_assets_retired_update BEFORE UPDATE OF r2_key, pass_id, name ON pass_assets
WHEN (NEW.r2_key IS NOT OLD.r2_key OR NEW.pass_id IS NOT OLD.pass_id OR NEW.name IS NOT OLD.name)
  AND EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.r2_key)
  AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_candidates c WHERE c.pass_id = NEW.pass_id
    AND c.kind = 'asset' AND c.slot = NEW.name AND c.r2_key = NEW.r2_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;
CREATE TRIGGER member_photos_retired_insert BEFORE INSERT ON member_photos
WHEN EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.r2_key)
  AND NOT EXISTS (SELECT 1 FROM member_photos m
    WHERE m.pass_id = NEW.pass_id AND m.org_id = NEW.org_id AND m.r2_key = NEW.r2_key)
  AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_candidates c WHERE c.pass_id = NEW.pass_id
    AND c.kind = 'photo' AND c.r2_key = NEW.r2_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;
CREATE TRIGGER member_photos_retired_update BEFORE UPDATE OF r2_key, pass_id, org_id ON member_photos
WHEN (NEW.r2_key IS NOT OLD.r2_key OR NEW.pass_id IS NOT OLD.pass_id OR NEW.org_id IS NOT OLD.org_id)
  AND EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.r2_key)
  AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_candidates c WHERE c.pass_id = NEW.pass_id
    AND c.kind = 'photo' AND c.r2_key = NEW.r2_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;

-- These tables normally use different namespaces, but a legacy reference may point into an
-- asset namespace.  Protect it as well, including against a reference racing a GC claim.
CREATE TRIGGER passes_retired_object_insert BEFORE INSERT ON passes
WHEN EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.object_key)
  AND NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.id AND p.object_key = NEW.object_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;
CREATE TRIGGER passes_retired_object_update BEFORE UPDATE OF object_key ON passes
WHEN NEW.object_key IS NOT OLD.object_key
  AND EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.object_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;
CREATE TRIGGER pass_versions_retired_object_insert BEFORE INSERT ON pass_versions
WHEN EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.object_key)
  AND NOT EXISTS (SELECT 1 FROM pass_versions v WHERE v.pass_id = NEW.pass_id
    AND v.version = NEW.version AND v.object_key = NEW.object_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;
CREATE TRIGGER pass_versions_retired_object_update
BEFORE UPDATE OF pass_id, version, object_key ON pass_versions
WHEN (NEW.object_key IS NOT OLD.object_key OR NEW.pass_id IS NOT OLD.pass_id OR NEW.version IS NOT OLD.version)
  AND EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.object_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;
CREATE TRIGGER template_imports_retired_object_insert BEFORE INSERT ON template_imports
WHEN EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.object_key)
  AND NOT EXISTS (SELECT 1 FROM template_imports i
    WHERE i.upload_id = NEW.upload_id AND i.object_key = NEW.object_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;
CREATE TRIGGER template_imports_retired_object_update
BEFORE UPDATE OF upload_id, object_key ON template_imports
WHEN (NEW.object_key IS NOT OLD.object_key OR NEW.upload_id IS NOT OLD.upload_id)
  AND EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.object_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;
CREATE TRIGGER template_extras_retired_insert BEFORE INSERT ON template_version_extras
WHEN EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.r2_key)
  AND NOT EXISTS (SELECT 1 FROM template_version_extras e WHERE e.template_id = NEW.template_id
    AND e.version = NEW.version AND e.name = NEW.name AND e.r2_key = NEW.r2_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;
-- Template versions and extras are already immutable after insertion.
CREATE TRIGGER template_versions_retired_assets_insert BEFORE INSERT ON template_versions
WHEN EXISTS (SELECT 1 FROM json_tree(NEW.assets) j JOIN pass_transfer_asset_gc gc ON gc.r2_key = j.value
  WHERE j.key = 'key' AND j.type = 'text')
  AND NOT EXISTS (SELECT 1 FROM template_versions v WHERE v.template_id = NEW.template_id
    AND v.version = NEW.version AND v.assets = NEW.assets)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;

CREATE TRIGGER issuance_retired_object_insert BEFORE INSERT ON pass_issuance_deliveries
WHEN EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc
  WHERE gc.r2_key = NEW.source_object_key OR gc.r2_key = NEW.target_object_key)
  AND NOT EXISTS (SELECT 1 FROM pass_issuance_deliveries i WHERE i.pass_id = NEW.pass_id
    AND i.source_object_key IS NEW.source_object_key AND i.target_object_key IS NEW.target_object_key)
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;
CREATE TRIGGER issuance_retired_object_update
BEFORE UPDATE OF source_object_key, target_object_key ON pass_issuance_deliveries
WHEN (NEW.source_object_key IS NOT OLD.source_object_key AND EXISTS
       (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.source_object_key))
  OR (NEW.target_object_key IS NOT OLD.target_object_key AND EXISTS
       (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = NEW.target_object_key))
BEGIN SELECT RAISE(ABORT, 'retired pass asset key'); END;

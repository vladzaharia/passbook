-- Access zones: org data (not per mode), linked to scanning sessions; zone, visit and plan on scans.

CREATE TABLE scan_zones (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 40 AND key NOT GLOB '*[^a-z0-9-]*' AND substr(key, 1, 1) GLOB '[a-z0-9]'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  parent_id TEXT REFERENCES scan_zones (id) ON DELETE CASCADE,
  time_zone TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  occupancy TEXT NOT NULL DEFAULT 'off' CHECK (occupancy IN ('off', 'track', 'enforce')),
  capacity INTEGER CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 100000),
  max_stay_minutes INTEGER CHECK (max_stay_minutes IS NULL OR max_stay_minutes BETWEEN 15 AND 2880),
  clear_at TEXT CHECK (clear_at IS NULL OR (clear_at GLOB '[0-2][0-9]:[0-5][0-9]' AND clear_at < '24:00')),
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (parent_id IS NULL OR time_zone IS NULL),
  CHECK (occupancy <> 'off' OR (capacity IS NULL AND max_stay_minutes IS NULL AND clear_at IS NULL))
);
CREATE UNIQUE INDEX scan_zones_org_key ON scan_zones (org_id, key);
CREATE UNIQUE INDEX scan_zones_org_name ON scan_zones (org_id, name COLLATE NOCASE) WHERE archived_at IS NULL;
CREATE INDEX scan_zones_parent ON scan_zones (parent_id);
CREATE INDEX scan_zones_created_by ON scan_zones (created_by);

CREATE TABLE scanning_session_zones (
  session_id TEXT NOT NULL REFERENCES scanning_sessions (id) ON DELETE CASCADE,
  zone_id TEXT NOT NULL REFERENCES scan_zones (id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, zone_id)
) WITHOUT ROWID;
CREATE INDEX scanning_session_zones_zone ON scanning_session_zones (zone_id);

-- A link change is a session configuration change (devices refetch).
CREATE TRIGGER scanning_session_zones_config_insert AFTER INSERT ON scanning_session_zones
BEGIN UPDATE scanning_sessions SET config_epoch = config_epoch + 1 WHERE id = NEW.session_id; END;
CREATE TRIGGER scanning_session_zones_config_update AFTER UPDATE OF session_id, zone_id, sort ON scanning_session_zones
WHEN NEW.session_id IS NOT OLD.session_id OR NEW.zone_id IS NOT OLD.zone_id OR NEW.sort IS NOT OLD.sort
BEGIN UPDATE scanning_sessions SET config_epoch = config_epoch + 1 WHERE id IN (NEW.session_id, OLD.session_id); END;
CREATE TRIGGER scanning_session_zones_config_delete AFTER DELETE ON scanning_session_zones
BEGIN UPDATE scanning_sessions SET config_epoch = config_epoch + 1 WHERE id = OLD.session_id; END;

-- The deciding zone, whether the scan started a visit, and the plan then. Not foreign keys: proof outlives config.
ALTER TABLE scans ADD COLUMN zone_id TEXT;
ALTER TABLE scans ADD COLUMN visit INTEGER CHECK (visit IS NULL OR visit IN (0, 1));
ALTER TABLE scans ADD COLUMN access_plan TEXT;
CREATE INDEX scans_zone ON scans (zone_id, at DESC) WHERE zone_id IS NOT NULL;

-- Links between a connection's upstream objects and local passes. The pass's own
-- connection_id/external_ref stays the primary source; triggers mirror it as the 'primary'
-- link ('record') on every insert, bind, unbind, move and delete, in the same statement batch.
CREATE TABLE connection_links (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  object_type TEXT NOT NULL CHECK (length(object_type) BETWEEN 1 AND 64),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  local_id TEXT NOT NULL CHECK (length(local_id) BETWEEN 1 AND 64),
  role TEXT NOT NULL DEFAULT 'secondary' CHECK (role IN ('primary', 'secondary')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'tombstoned')),
  last_pushed_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (connection_id, object_type, external_id),
  UNIQUE (connection_id, object_type, local_id)
);
CREATE INDEX connection_links_org_object ON connection_links (org_id, object_type, external_id);
CREATE INDEX connection_links_local ON connection_links (org_id, local_id);

INSERT INTO connection_links
  (id, org_id, connection_id, object_type, external_id, local_id, role, state, created_at, updated_at)
SELECT 'primary:' || id, org_id, connection_id, 'record', external_ref, id, 'primary', 'active',
  created_at, created_at
FROM passes
WHERE connection_id IS NOT NULL AND external_ref IS NOT NULL;

CREATE TRIGGER passes_link_insert AFTER INSERT ON passes
WHEN NEW.connection_id IS NOT NULL AND NEW.external_ref IS NOT NULL
BEGIN
  INSERT INTO connection_links
    (id, org_id, connection_id, object_type, external_id, local_id, role, state, created_at, updated_at)
  VALUES ('primary:' || NEW.id, NEW.org_id, NEW.connection_id, 'record', NEW.external_ref, NEW.id,
    'primary', 'active', NEW.created_at, NEW.created_at);
END;

CREATE TRIGGER passes_link_update AFTER UPDATE OF connection_id, external_ref ON passes
WHEN OLD.connection_id IS NOT NEW.connection_id OR OLD.external_ref IS NOT NEW.external_ref
BEGIN
  DELETE FROM connection_links WHERE id = 'primary:' || OLD.id;
  INSERT INTO connection_links
    (id, org_id, connection_id, object_type, external_id, local_id, role, state, created_at, updated_at)
  SELECT 'primary:' || NEW.id, NEW.org_id, NEW.connection_id, 'record', NEW.external_ref, NEW.id,
    'primary', 'active', NEW.modified_at, NEW.modified_at
  WHERE NEW.connection_id IS NOT NULL AND NEW.external_ref IS NOT NULL;
END;

CREATE TRIGGER passes_link_delete AFTER DELETE ON passes
BEGIN
  DELETE FROM connection_links WHERE local_id = OLD.id;
END;

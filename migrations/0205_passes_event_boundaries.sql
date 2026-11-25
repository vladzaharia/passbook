-- Passes whose built pass lists upcoming events, which change with the clock (the active event, past
-- events, their relevance windows). A boundary never makes a version (docs/design/event-boundaries.md):
-- the row holds the timed keys of the current artifact and an update tag of their own, so every fence
-- on passes.version and passes.revision stays as it was.
CREATE TABLE pass_boundaries (
  pass_id TEXT PRIMARY KEY REFERENCES passes (id) ON DELETE CASCADE,
  -- The artifact the row describes: its pass_versions row.
  version INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  -- When the row is next worked out; NULL once no boundary is left.
  due_at INTEGER,
  -- When the timed keys below were worked out; 0 while devices get the artifact as built.
  rendered_at INTEGER NOT NULL DEFAULT 0,
  render TEXT CHECK (render IS NULL OR json_valid(render)),
  -- The render's update tag (a revisions row) and when it was taken, for updated-since and Last-Modified.
  stamp INTEGER NOT NULL DEFAULT 0,
  stamped_at INTEGER NOT NULL DEFAULT 0,
  -- Failed runs in a row; the next one waits longer.
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pass_boundaries_due ON pass_boundaries (due_at, pass_id);

-- A new artifact that lists events, or that replaces one that did, is worked out from scratch now. A
-- developer org's passes are never signed (orgs.kind never changes). stamped_at stays: a publish in the
-- same second as the last render must not hide behind its Last-Modified, and renders stay 5 minutes apart.
CREATE TRIGGER pass_boundaries_mark AFTER INSERT ON pass_versions
WHEN NEW.pass_json IS NOT NULL AND NEW.object_key IS NOT NULL
  AND (instr(NEW.pass_json, '"upcomingPassInformation"') > 0
    OR EXISTS (SELECT 1 FROM pass_boundaries b WHERE b.pass_id = NEW.pass_id))
  AND NOT EXISTS (SELECT 1 FROM passes p JOIN orgs o ON o.id = p.org_id
    WHERE p.id = NEW.pass_id AND o.kind = 'developer')
BEGIN
  INSERT INTO pass_boundaries (pass_id, version, object_key, due_at)
  VALUES (NEW.pass_id, NEW.version, NEW.object_key, NEW.created_at)
  ON CONFLICT (pass_id) DO UPDATE SET version = excluded.version, object_key = excluded.object_key,
    due_at = excluded.due_at, rendered_at = 0, render = NULL, stamp = 0, attempts = 0;
END;

-- A new render takes the next update tag, as a publish does (0045 pass_published).
CREATE TRIGGER pass_boundaries_stamp AFTER UPDATE OF stamped_at ON pass_boundaries
WHEN NEW.stamped_at > OLD.stamped_at
BEGIN
  INSERT INTO revisions (pass_id, at) VALUES (NEW.pass_id, NEW.stamped_at);
  UPDATE pass_boundaries SET stamp = last_insert_rowid() WHERE pass_id = NEW.pass_id;
END;

-- Live passes that list events now. A metadata-only edit bumps passes.version without a row, so the
-- latest pass_versions row is the artifact.
INSERT INTO pass_boundaries (pass_id, version, object_key, due_at)
SELECT p.id, v.version, v.object_key, 0 FROM passes p
JOIN orgs o ON o.id = p.org_id AND o.kind != 'developer'
JOIN pass_versions v ON v.pass_id = p.id
  AND v.version = (SELECT MAX(x.version) FROM pass_versions x WHERE x.pass_id = p.id)
WHERE p.deleted_at IS NULL AND p.status = 'active' AND p.removed_at IS NULL
  AND v.object_key IS NOT NULL AND v.pass_json IS NOT NULL
  AND instr(v.pass_json, '"upcomingPassInformation"') > 0;

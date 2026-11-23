-- Passes whose built pass lists upcoming events change with the clock (the active event, the next-event
-- highlight). One row per such pass: due_at is the next start or end, or 0 while it is still to be worked out.
CREATE TABLE pass_boundaries (
  pass_id TEXT PRIMARY KEY REFERENCES passes (id) ON DELETE CASCADE,
  due_at INTEGER NOT NULL
);
CREATE INDEX pass_boundaries_due ON pass_boundaries (due_at);

-- Any new version that lists events, or that replaces one that did, asks for the date to be worked out again.
CREATE TRIGGER pass_boundaries_mark AFTER INSERT ON pass_versions
WHEN NEW.pass_json IS NOT NULL
  AND (instr(NEW.pass_json, '"upcomingPassInformation"') > 0
    OR EXISTS (SELECT 1 FROM pass_boundaries b WHERE b.pass_id = NEW.pass_id))
BEGIN
  INSERT INTO pass_boundaries (pass_id, due_at) VALUES (NEW.pass_id, 0)
  ON CONFLICT (pass_id) DO UPDATE SET due_at = 0;
END;

INSERT INTO pass_boundaries (pass_id, due_at)
SELECT p.id, 0 FROM passes p
WHERE p.deleted_at IS NULL AND p.status = 'active'
  AND EXISTS (SELECT 1 FROM pass_versions v WHERE v.pass_id = p.id AND v.version = p.version
    AND v.pass_json IS NOT NULL AND instr(v.pass_json, '"upcomingPassInformation"') > 0);

-- A card a public join link made stays marked as one for good: a joiner's address is unverified, so the attach
-- path rotates or refuses on this mark. join_issues cascades with its link or template and cannot serve.
CREATE TABLE join_marks (
  pass_id TEXT PRIMARY KEY REFERENCES passes (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  created_at INTEGER NOT NULL
);
INSERT INTO join_marks (pass_id, org_id, mode, created_at)
SELECT pass_id, org_id, mode, created_at FROM join_issues;

CREATE TRIGGER join_marks_scope BEFORE INSERT ON join_marks
WHEN NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode)
BEGIN SELECT RAISE(ABORT, 'a join mark matches its pass in org and mode'); END;

CREATE TRIGGER join_marks_immutable BEFORE UPDATE ON join_marks
BEGIN SELECT RAISE(ABORT, 'a join mark never changes'); END;

-- A mark leaves only with its pass (the foreign key cascade runs once the pass is gone), never by a link or template delete.
CREATE TRIGGER join_marks_no_delete BEFORE DELETE ON join_marks
WHEN EXISTS (SELECT 1 FROM passes p WHERE p.id = OLD.pass_id)
BEGIN SELECT RAISE(ABORT, 'a join mark goes with its pass'); END;

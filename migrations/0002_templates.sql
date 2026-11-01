-- Template uploads may have no organization.
CREATE TABLE template_imports_new (
  upload_id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs (id) ON DELETE CASCADE,
  name TEXT,
  object_key TEXT NOT NULL,
  step TEXT,
  template_id TEXT,
  version TEXT,
  report TEXT CHECK (report IS NULL OR json_valid(report)),
  error TEXT,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO template_imports_new SELECT * FROM template_imports;
DROP TABLE template_imports;
ALTER TABLE template_imports_new RENAME TO template_imports;
CREATE INDEX template_imports_org ON template_imports (org_id, created_at DESC);
CREATE INDEX template_imports_created_by ON template_imports (created_by);

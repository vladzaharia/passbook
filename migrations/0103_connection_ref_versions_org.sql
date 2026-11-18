-- connection_ref_versions gets its own org column so a connection grant can upsert it (authority-tables.ts).
-- 0102 created it empty and nothing wrote to it yet.
DROP TABLE connection_ref_versions;
CREATE TABLE connection_ref_versions (
  org_id TEXT NOT NULL REFERENCES orgs (id),
  connection_id TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  ref TEXT NOT NULL CHECK (length(ref) <= 200),
  source_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, ref)
);

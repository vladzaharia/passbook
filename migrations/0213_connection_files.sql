-- Files behind a file-upload connection: one row per upload (drafts included). The bytes and parsed pages live in
-- R2 under uploads/connection-files/<org>/<file>/. connection_id has no cascade: rows go first, then objects.
CREATE TABLE connection_files (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  connection_id TEXT REFERENCES connections (id),
  revision INTEGER CHECK (revision IS NULL OR revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('draft', 'pending', 'current', 'superseded', 'expired', 'discarded')),
  name TEXT NOT NULL CHECK (length(name) <= 200),
  format TEXT NOT NULL CHECK (format IN ('csv', 'xlsx', 'json', 'ndjson')),
  sheet TEXT,
  records_pointer TEXT,
  id_pointer TEXT,
  -- Column labels in file order, as a JSON array.
  column_labels TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  rows INTEGER NOT NULL,
  columns INTEGER NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0,
  skipped_no_id INTEGER,
  skipped_duplicate INTEGER,
  diff_added INTEGER,
  diff_changed INTEGER,
  diff_removed INTEGER,
  -- At most 5 refs of each kind, as JSON: {"added":[],"changed":[],"removed":[]}.
  diff_examples TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  superseded_at INTEGER,
  UNIQUE (connection_id, revision)
);
CREATE INDEX connection_files_conn ON connection_files (connection_id, state);
CREATE INDEX connection_files_sweep ON connection_files (state, expires_at);
CREATE INDEX connection_files_org ON connection_files (org_id, state);
CREATE UNIQUE INDEX connection_files_one_current ON connection_files (connection_id) WHERE state = 'current';
CREATE UNIQUE INDEX connection_files_one_pending ON connection_files (connection_id) WHERE state = 'pending';

-- Bulk runs: a background action over every pass a filter matched (POST /passes/bulk-runs). The ids sit in
-- R2 pages; the run keeps its cursor and counts here. One active run per organization and mode.
CREATE TABLE pass_bulk_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  action TEXT NOT NULL CHECK (action IN ('void', 'send_email', 'remove')),
  message TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'stopped', 'failed')),
  total INTEGER NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  skipped_by TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(skipped_by)),
  starter TEXT NOT NULL CHECK (json_valid(starter)),
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0, 1)),
  code TEXT,
  created_at INTEGER NOT NULL,
  moved_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX pass_bulk_runs_state ON pass_bulk_runs (state, moved_at);
CREATE INDEX pass_bulk_runs_org ON pass_bulk_runs (org_id, created_at DESC);

CREATE TABLE pass_bulk_locks (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  run_id TEXT NOT NULL,
  moved_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, mode)
);

-- Saved views of the passes list, one list per organization and mode. `revision` is the optimistic
-- concurrency token of a save.
CREATE TABLE pass_views (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  revision INTEGER NOT NULL,
  items TEXT NOT NULL CHECK (json_valid(items)),
  moved_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, mode)
);

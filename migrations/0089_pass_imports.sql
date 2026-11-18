-- Import from CSV and Sheets: a draft per upload, one row per file row, and the plan saved per template.
CREATE TABLE pass_imports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  template_id TEXT NOT NULL,
  release_id TEXT,
  release_generation INTEGER,
  template_version TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('file', 'url')),
  source_name TEXT NOT NULL,
  object_key TEXT,
  object_sha256 TEXT,
  plan TEXT CHECK (plan IS NULL OR json_valid(plan)),
  state TEXT NOT NULL CHECK (state IN
    ('mapping', 'checking', 'ready', 'committing', 'done', 'failed', 'stale', 'expired', 'discarded')),
  error_code TEXT,
  email INTEGER NOT NULL DEFAULT 0 CHECK (email IN (0, 1)),
  skip_invalid INTEGER NOT NULL DEFAULT 0 CHECK (skip_invalid IN (0, 1)),
  email_budget INTEGER,
  rows INTEGER NOT NULL DEFAULT 0,
  to_create INTEGER NOT NULL DEFAULT 0,
  to_update INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  warnings INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  not_emailed INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  starter TEXT CHECK (starter IS NULL OR json_valid(starter)),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  checked_at INTEGER,
  committed_at INTEGER,
  finished_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX pass_imports_org ON pass_imports (org_id, mode, created_at DESC);
CREATE UNIQUE INDEX pass_imports_one_running ON pass_imports (org_id, mode, template_id)
  WHERE state = 'committing';
CREATE INDEX pass_imports_expiry ON pass_imports (expires_at)
  WHERE state IN ('mapping', 'checking', 'ready', 'stale');

CREATE TABLE pass_import_rows (
  import_id TEXT NOT NULL REFERENCES pass_imports(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'unchanged', 'error')),
  pass_id TEXT,
  expected_version INTEGER,
  external_id TEXT,
  holder_email TEXT,
  input TEXT CHECK (input IS NULL OR json_valid(input)),
  problems TEXT CHECK (problems IS NULL OR json_valid(problems)),
  state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'done', 'failed', 'skipped')),
  result TEXT CHECK (result IS NULL OR result IN ('created', 'updated', 'unchanged')),
  code TEXT,
  emailed INTEGER NOT NULL DEFAULT 0 CHECK (emailed IN (0, 1)),
  before TEXT CHECK (before IS NULL OR json_valid(before)),
  PRIMARY KEY (import_id, row_no)
) WITHOUT ROWID;
CREATE INDEX pass_import_rows_pass ON pass_import_rows (pass_id) WHERE pass_id IS NOT NULL;

CREATE TABLE pass_import_mappings (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  template_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (json_valid(plan)),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, template_id)
);

-- workflow_runs.kind grows by a rebuild. workflow_release_snapshot_sets references it with ON DELETE
-- CASCADE, so those rows are copied out first and put back.
CREATE TABLE _keep_workflow_runs AS SELECT * FROM workflow_runs;
CREATE TABLE _keep_snapshot_sets AS SELECT * FROM workflow_release_snapshot_sets;
CREATE TABLE _keep_snapshots AS SELECT * FROM workflow_release_snapshots;
DROP TABLE workflow_runs;
CREATE TABLE workflow_runs (
  instance_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL
    CHECK (kind IN ('template_import', 'bulk_reissue', 'connection_sync', 'broadcast', 'pass_import')),
  org_id TEXT,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'errored', 'terminated')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_code TEXT,
  credential_keyset_commitment TEXT
    CHECK (credential_keyset_commitment IS NULL OR
      (length(credential_keyset_commitment) = 64 AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'))
);
INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at, finished_at, error_code, credential_keyset_commitment)
  SELECT instance_id, kind, org_id, target_id, status, started_at, finished_at, error_code, credential_keyset_commitment
  FROM _keep_workflow_runs;
CREATE INDEX workflow_runs_kind ON workflow_runs (kind, started_at DESC);
CREATE INDEX workflow_runs_target ON workflow_runs (target_id, started_at DESC);
CREATE TRIGGER connection_workflow_keyset_immutable
BEFORE UPDATE OF credential_keyset_commitment ON workflow_runs
WHEN NEW.credential_keyset_commitment IS NOT OLD.credential_keyset_commitment
BEGIN SELECT RAISE(ABORT, 'workflow key commitment is immutable'); END;
INSERT INTO workflow_release_snapshot_sets (instance_id) SELECT instance_id FROM _keep_snapshot_sets;
INSERT INTO workflow_release_snapshots (instance_id, org_id, mode, template_id, release_id, generation, version)
  SELECT instance_id, org_id, mode, template_id, release_id, generation, version FROM _keep_snapshots;
DROP TABLE _keep_snapshots;
DROP TABLE _keep_snapshot_sets;
DROP TABLE _keep_workflow_runs;

-- Managed identities, part 2: handles, rotation state and provisioning runs.
-- A handle names a managed pass type (pass.mobile.passbook.<handle>) and is reserved forever.
CREATE TABLE identity_handles (
  handle TEXT PRIMARY KEY
    CHECK (handle GLOB '[a-z]*' AND handle NOT GLOB '*[^a-z0-9]*' AND length(handle) BETWEEN 2 AND 30),
  org_id TEXT, -- no foreign key: the reservation survives an org purge
  reserved_at INTEGER NOT NULL
);
CREATE TRIGGER identity_handles_no_delete BEFORE DELETE ON identity_handles
BEGIN
  SELECT RAISE(ABORT, 'IDENTITY_HANDLE_RESERVED');
END;
CREATE TRIGGER identity_handles_no_reassign BEFORE UPDATE ON identity_handles
BEGIN
  SELECT RAISE(ABORT, 'IDENTITY_HANDLE_RESERVED');
END;
-- INSERT OR REPLACE fires no delete trigger: turn a replace of a held handle into a no-op.
CREATE TRIGGER identity_handles_no_replace BEFORE INSERT ON identity_handles
WHEN EXISTS (SELECT 1 FROM identity_handles WHERE handle = NEW.handle)
BEGIN
  SELECT RAISE(IGNORE);
END;
INSERT INTO identity_handles (handle, org_id, reserved_at) VALUES
  ('wallet', NULL, 0), ('test', NULL, 0), ('demo', NULL, 0), ('platform', NULL, 0),
  ('passbook', NULL, 0), ('apple', NULL, 0), ('google', NULL, 0), ('samsung', NULL, 0),
  ('admin', NULL, 0), ('api', NULL, 0);

ALTER TABLE signing_identities ADD COLUMN rotation TEXT NOT NULL DEFAULT 'manual'
  CHECK (rotation IN ('auto', 'csr', 'manual'));
ALTER TABLE signing_identities ADD COLUMN next_rotation_at INTEGER;
-- Apple's opaque pass type id and the account that owns it ('platform' or a delegated ref); NULL for own.
ALTER TABLE signing_identities ADD COLUMN asc_pass_type_id TEXT;
ALTER TABLE signing_identities ADD COLUMN asc_account TEXT;
ALTER TABLE signing_identities ADD COLUMN handle TEXT REFERENCES identity_handles (handle);
-- Auto rotation starts only once the env identity is adopted, so env rows stay manual.
UPDATE signing_identities SET provenance = 'platform', rotation = 'manual' WHERE org_id IS NULL;
CREATE INDEX signing_identities_handle ON signing_identities (handle) WHERE handle IS NOT NULL;
CREATE INDEX signing_identities_rotation_due ON signing_identities (next_rotation_at) WHERE rotation = 'auto';

CREATE TABLE identity_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'samsung')),
  mode TEXT CHECK (mode IN ('live', 'test')),
  kind TEXT NOT NULL CHECK (kind IN ('provision', 'rotate', 'revoke', 'adopt', 'cards')),
  target_type TEXT NOT NULL CHECK (target_type IN ('identity', 'wallet_credential', 'org')),
  target_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  step TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  waiting_for TEXT,
  csr_pubkey_sha256 TEXT,
  external_ref TEXT CHECK (external_ref IS NULL OR json_valid(external_ref)),
  error_code TEXT,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX identity_runs_one_open ON identity_runs (target_type, target_id, kind)
  WHERE state IN ('queued', 'running', 'waiting');
CREATE INDEX identity_runs_org ON identity_runs (org_id, created_at);
CREATE INDEX identity_runs_target ON identity_runs (target_type, target_id, created_at);
CREATE INDEX identity_runs_created_by ON identity_runs (created_by) WHERE created_by IS NOT NULL;

-- Any change of an auto identity's certificate (rotation run or manual upload) moves its next rotation to 60 days before expiry.
CREATE TRIGGER signing_identities_next_rotation AFTER UPDATE OF cert_sha256 ON signing_identities
WHEN NEW.rotation = 'auto' AND NEW.not_after IS NOT NULL AND NEW.cert_sha256 IS NOT OLD.cert_sha256
BEGIN
  UPDATE signing_identities SET next_rotation_at = NEW.not_after - 5184000000 WHERE id = NEW.id;
END;

-- A developer org holds no Live row, whoever writes it (0156).
CREATE TRIGGER identity_runs_developer_no_live BEFORE INSERT ON identity_runs
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live identity run'); END;

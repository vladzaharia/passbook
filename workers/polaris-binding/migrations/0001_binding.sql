-- Signup tokens the binding minted. The value is never stored: a SHA-256 for the v2 audit layout, the id for the admin layout.
CREATE TABLE idp_signups (
  token_id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('member', 'developer', 'member_developer')),
  ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'minted' CHECK (state IN ('minted', 'deleted', 'used', 'proven')),
  subject TEXT UNIQUE
) STRICT;

-- Accounts the binding knows. created: a proven signup. linked: the binding added a role to an existing account.
-- external: seen in a registry group without a grant (read only). disabled_by_binding_at: only that disable may be undone.
CREATE TABLE idp_subjects (
  subject TEXT PRIMARY KEY,
  class TEXT NOT NULL CHECK (class IN ('created', 'linked', 'external')),
  created_at INTEGER NOT NULL,
  token_id TEXT REFERENCES idp_signups (token_id),
  disabled_by_binding_at INTEGER
) STRICT;

-- What the binding added, so it knows what it may take back. One live row per (subject, role).
CREATE TABLE idp_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('console', 'developer', 'support')),
  source TEXT NOT NULL CHECK (source IN ('signup', 'added', 'override')),
  ref TEXT,
  token_id TEXT REFERENCES idp_signups (token_id),
  created_at INTEGER NOT NULL,
  -- Set once the write is read back. A grant without it is pending: a snapshot never ends it.
  confirmed_at INTEGER,
  removed_at INTEGER,
  removed_reason TEXT
) STRICT;

CREATE UNIQUE INDEX idp_grants_live ON idp_grants (subject, role) WHERE removed_at IS NULL;

-- The last health read, so writes do not re-read Polaris ID's configuration on every call.
CREATE TABLE idp_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at INTEGER NOT NULL,
  unsafe TEXT NOT NULL,
  warnings TEXT NOT NULL,
  groups TEXT NOT NULL,
  key_subject TEXT,
  key_expires_at INTEGER,
  layout_suspect INTEGER NOT NULL
) STRICT;

-- Append-only ledger. A call writes `start` rows (the budget reservations) and then `end`; a refused,
-- over-budget, breaker-stopped or dry-run call writes its own row. No bodies, tokens, urls, emails or key material.
CREATE TABLE idp_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('start', 'end', 'refused', 'budget', 'dry_run', 'breaker')),
  method TEXT NOT NULL,
  bucket TEXT,
  target TEXT,
  caller TEXT,
  actor TEXT,
  reason TEXT,
  role TEXT,
  delta TEXT,
  status TEXT,
  request_id TEXT,
  duration_ms INTEGER,
  at INTEGER NOT NULL
) STRICT;

CREATE INDEX idp_calls_bucket_at ON idp_calls (bucket, phase, at);

CREATE TRIGGER idp_calls_no_update BEFORE UPDATE ON idp_calls
BEGIN SELECT RAISE(ABORT, 'idp_calls is append-only'); END;

CREATE TRIGGER idp_calls_no_delete BEFORE DELETE ON idp_calls
BEGIN SELECT RAISE(ABORT, 'idp_calls is append-only'); END;

-- Removals and disables one run (`ref`) has used. The breaker stops a run past its limits.
CREATE TABLE idp_breaker (
  ref TEXT PRIMARY KEY,
  removals INTEGER NOT NULL DEFAULT 0,
  disables INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
) STRICT;

-- Pause changes. Rows are never deleted; thawed_at is set once, and only by the owner through
-- `wrangler d1 execute` (docs/operations.md). No RPC thaws.
CREATE TABLE idp_freezes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  thawed_at INTEGER
) STRICT;

CREATE TRIGGER idp_freezes_no_delete BEFORE DELETE ON idp_freezes
BEGIN SELECT RAISE(ABORT, 'idp_freezes is append-only'); END;

CREATE TRIGGER idp_freezes_thaw_once BEFORE UPDATE ON idp_freezes
WHEN OLD.thawed_at IS NOT NULL OR NEW.thawed_at IS NULL OR NEW.id != OLD.id OR NEW.at != OLD.at
  OR NEW.reason != OLD.reason OR NEW.actor != OLD.actor
BEGIN SELECT RAISE(ABORT, 'idp_freezes: only thawed_at may be set, once'); END;

-- One change per account at a time. A lease the holder releases; an expired one may be taken over.
CREATE TABLE idp_locks (
  subject TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  until INTEGER NOT NULL
) STRICT;

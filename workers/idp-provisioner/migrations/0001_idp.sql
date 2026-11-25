-- Signup tokens the provisioner minted. The value is never stored: a SHA-256 for the v2 audit layout, the id for the admin layout.
CREATE TABLE idp_signups (
  token_id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'minted' CHECK (state IN ('minted', 'deleted', 'used', 'proven')),
  subject TEXT UNIQUE
) STRICT;

-- Who the provisioner may take the developers group from: accounts a minted token created, and accounts it added the group to.
CREATE TABLE idp_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('signup', 'added')),
  token_id TEXT REFERENCES idp_signups (token_id),
  created_at INTEGER NOT NULL,
  removed_at INTEGER
) STRICT;

CREATE UNIQUE INDEX idp_grants_live ON idp_grants (subject) WHERE removed_at IS NULL;

-- The last health read, so writes do not re-read Pocket ID's configuration on every call.
CREATE TABLE idp_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at INTEGER NOT NULL,
  unsafe TEXT NOT NULL,
  group_name TEXT,
  key_expires_at INTEGER,
  layout_suspect INTEGER NOT NULL
) STRICT;

-- Append-only ledger. A call writes `start` (the budget reservation) and then `end`; a refused or
-- over-budget call writes one `refused` or `budget` row. No bodies, tokens, urls or key material.
CREATE TABLE idp_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('start', 'end', 'refused', 'budget')),
  method TEXT NOT NULL,
  target TEXT,
  caller TEXT,
  status TEXT,
  request_id TEXT,
  duration_ms INTEGER,
  at INTEGER NOT NULL
) STRICT;

CREATE INDEX idp_calls_method_at ON idp_calls (method, phase, at);

CREATE TRIGGER idp_calls_no_update BEFORE UPDATE ON idp_calls
BEGIN SELECT RAISE(ABORT, 'idp_calls is append-only'); END;

CREATE TRIGGER idp_calls_no_delete BEFORE DELETE ON idp_calls
BEGIN SELECT RAISE(ABORT, 'idp_calls is append-only'); END;

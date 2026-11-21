-- Pass type IDs the provisioner may act on: the ones it created, plus rows the owner seeds.
CREATE TABLE asc_pass_types (
  identifier TEXT PRIMARY KEY,
  asc_id TEXT UNIQUE,
  name TEXT,
  source TEXT NOT NULL CHECK (source IN ('created', 'seeded')),
  created_at INTEGER NOT NULL
) STRICT;

-- Append-only ledger. A call writes `start` (the budget reservation) and then `end`; a refused or
-- over-budget call writes one `refused` or `budget` row. No bodies, tokens or key material.
CREATE TABLE asc_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('start', 'end', 'refused', 'budget')),
  method TEXT NOT NULL,
  target TEXT,
  caller TEXT,
  status TEXT,
  apple_request_id TEXT,
  duration_ms INTEGER,
  at INTEGER NOT NULL
) STRICT;

CREATE INDEX asc_calls_method_at ON asc_calls (method, phase, at);

CREATE TRIGGER asc_calls_no_update BEFORE UPDATE ON asc_calls
BEGIN SELECT RAISE(ABORT, 'asc_calls is append-only'); END;

CREATE TRIGGER asc_calls_no_delete BEFORE DELETE ON asc_calls
BEGIN SELECT RAISE(ABORT, 'asc_calls is append-only'); END;

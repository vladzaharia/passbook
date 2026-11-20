-- Staff notes on a pass (OP-4): one line each, written by Desk and above on a paired scanner, read by the same roles.
-- They go with the pass (the cascade) and age with the scans retention window; never on a customer screen.
CREATE TABLE pass_notes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
  -- The writer's name when written: staff names change and staff are removed, a note keeps its author.
  author_name TEXT NOT NULL CHECK (length(author_name) BETWEEN 1 AND 120),
  author_staff_id TEXT,
  scanner_id TEXT,
  -- The device's retry key: one tap sent twice is one note.
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 64),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX pass_notes_key ON pass_notes (pass_id, idempotency_key);
CREATE INDEX pass_notes_pass ON pass_notes (pass_id, created_at DESC, id DESC);
CREATE INDEX pass_notes_age ON pass_notes (org_id, created_at);

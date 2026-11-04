-- Broadcasts: a message or scheduled change applied to the passes a target matches.
-- Added after 0016 may already be applied: nothing here depends on earlier gaps.

CREATE TABLE broadcasts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test')),
  kind TEXT NOT NULL CHECK (kind IN ('message', 'change')),
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'scheduled', 'sending', 'sent', 'partial', 'failed', 'cancelled')),
  target TEXT NOT NULL CHECK (json_valid(target)),
  patch TEXT NOT NULL CHECK (json_valid(patch)),
  notify INTEGER NOT NULL DEFAULT 1,
  at INTEGER,
  -- Milliseconds after the start that a message is cleared again.
  clear_after INTEGER,
  -- A follow-up only clears passes still showing this text: JSON of the input values to match.
  expect TEXT CHECK (expect IS NULL OR json_valid(expect)),
  parent_id TEXT REFERENCES broadcasts (id) ON DELETE SET NULL,
  targeted INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_by_type TEXT,
  created_by_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX broadcasts_org ON broadcasts (org_id, mode, id DESC);
CREATE INDEX broadcasts_due ON broadcasts (at) WHERE state = 'scheduled';
CREATE UNIQUE INDEX broadcasts_parent ON broadcasts (parent_id) WHERE parent_id IS NOT NULL;

-- One row per pass a run handled: a retried chunk skips them, and the counts come from here.
CREATE TABLE broadcast_items (
  broadcast_id TEXT NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('updated', 'unchanged', 'failed')),
  -- 1 when the update went out without a notification because of the daily limit.
  silent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (broadcast_id, pass_id)
) WITHOUT ROWID;
CREATE INDEX broadcast_items_pass ON broadcast_items (pass_id);

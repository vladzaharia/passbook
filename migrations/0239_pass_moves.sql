-- Identity move (operation `identity.move`): the settings of one run, and one row per pass it replaces.
-- A row fixes the replacement's id when it is planned, so a rerun creates it at most once. The pass ids carry
-- no foreign key: a removed pass leaves its row for the audit trail, and the org purge clears both tables.
CREATE TABLE identity_moves (
  op_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  from_identity_id TEXT NOT NULL,
  to_identity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE pass_moves (
  id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  from_identity_id TEXT NOT NULL,
  to_identity_id TEXT NOT NULL,
  old_pass_id TEXT NOT NULL UNIQUE,
  new_pass_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned', 'issued', 'notified', 'registered', 'voided', 'kept', 'failed')),
  -- A stable code: why the row is `kept` (connection, transfer, old_gone, new_gone, reminded) or `failed`.
  reason TEXT,
  -- What the replacement was built from, to tell later edits of the old pass from the move's own tell.
  copied_hash TEXT,
  told_at INTEGER,
  emailed_at INTEGER,
  remind_at INTEGER,
  reminded_at INTEGER,
  registered_at INTEGER,
  void_at INTEGER,
  -- Held while one sweep voids the old pass; a crashed sweep's claim lapses.
  claim_until INTEGER,
  voided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX pass_moves_op ON pass_moves (op_id, state);
CREATE INDEX pass_moves_void_due ON pass_moves (void_at) WHERE state = 'registered';
CREATE INDEX pass_moves_remind_due ON pass_moves (remind_at) WHERE state IN ('issued', 'notified') AND reminded_at IS NULL;
CREATE INDEX pass_moves_open ON pass_moves (state) WHERE state IN ('issued', 'notified', 'kept');

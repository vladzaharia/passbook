-- Offline check-in (PS-12): what a door decided with no connection, kept next to the scan `act` wrote.
-- Swept with the scans class (same window, holds, receipts). Ids, enums and times only: no code, name or pass data. A door refusal has no scan row, so this row is its record.
CREATE TABLE scan_offline_reads (
  id TEXT NOT NULL UNIQUE,
  pass_id TEXT,
  actor_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  session_id TEXT,
  scanner_id TEXT,
  door TEXT NOT NULL CHECK (door IN ('listed', 'unverified', 'refused')),
  scan_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'heads_up', 'refused')),
  reason TEXT,
  conflict INTEGER NOT NULL DEFAULT 0 CHECK (conflict IN (0, 1)),
  client_ts INTEGER NOT NULL,
  recorded_ts INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (actor_key, idempotency_key)
) WITHOUT ROWID;
CREATE INDEX scan_offline_reads_org ON scan_offline_reads (org_id, mode, synced_at DESC);
CREATE INDEX scan_offline_reads_conflict ON scan_offline_reads (org_id, mode, synced_at DESC) WHERE conflict = 1;

-- When a session's status or offline mode changed, so a queued read is judged by the state in force when the
-- door took it, not by the session's last edit. `prev_*` is what it was before, for reads older than any row.
CREATE TABLE scan_session_changes (
  session_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  prev_status TEXT NOT NULL,
  prev_mode TEXT NOT NULL,
  PRIMARY KEY (session_id, at)
) WITHOUT ROWID;

-- The door's last online contact with nothing waiting to sync: no queued read may be dated before it.
CREATE TABLE scan_offline_state (
  scanner_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  online_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX scan_session_changes_org ON scan_session_changes (org_id);
CREATE INDEX scan_offline_state_org ON scan_offline_state (org_id);

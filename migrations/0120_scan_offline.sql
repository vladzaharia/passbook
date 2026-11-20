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

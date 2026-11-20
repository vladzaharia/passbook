-- Roll call (PS-33): a frozen copy of Who's in for one scanning session, and each person's confirmation. The
-- snapshot is JSON so a person who leaves, expires or is deleted mid-call is never dropped from the list.
-- One open call per scope. While it is open the minute cron holds Max stay and Clear at exits in its places.
CREATE TABLE roll_calls (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  -- 'session:<id>' for a scanning session's devices, 'org' for a call over every tracked zone.
  scope_key TEXT NOT NULL,
  -- [{ place, name, basis }]: basis is 'in_now' where tap-out is required, else 'tapped_in'.
  places TEXT NOT NULL CHECK (json_valid(places)),
  -- [{ passId, holder, plan, host, place, since }] as the starter saw them.
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  started_by TEXT NOT NULL,
  started_by_id TEXT,
  scanner_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_by TEXT,
  -- Raised by every mark, so a device can tell a stale copy.
  rev INTEGER NOT NULL DEFAULT 0,
  CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);
CREATE UNIQUE INDEX roll_calls_open ON roll_calls (org_id, mode, scope_key) WHERE ended_at IS NULL;
CREATE INDEX roll_calls_started ON roll_calls (org_id, mode, started_at);

CREATE TABLE roll_call_marks (
  roll_call_id TEXT NOT NULL REFERENCES roll_calls (id) ON DELETE CASCADE,
  pass_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  status TEXT NOT NULL CHECK (status IN ('present', 'out', 'none')),
  by_name TEXT NOT NULL,
  scanner_id TEXT,
  -- Who a person who tapped in after the start is (a snapshot person's shape); null for one in the snapshot.
  late TEXT CHECK (late IS NULL OR json_valid(late)),
  -- The device's time of the mark: the later one wins, whatever order the two arrive in.
  marked_at INTEGER NOT NULL,
  PRIMARY KEY (roll_call_id, pass_id)
);

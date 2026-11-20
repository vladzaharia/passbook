-- A visitor: one visit by one pass, with the host who gets the arrival email. The pass is the
-- credential; this row holds the visit around it. Arrival comes from the scans, so only the
-- departure the desk records (left_at) and a cancellation are stored here. Rows go with the pass.
CREATE TABLE visitors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  pass_id TEXT NOT NULL UNIQUE REFERENCES passes (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  host_name TEXT NOT NULL CHECK (length(host_name) BETWEEN 1 AND 80),
  host_email TEXT NOT NULL CHECK (length(host_email) BETWEEN 3 AND 254),
  window_from INTEGER NOT NULL,
  window_until INTEGER NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 100),
  left_at INTEGER,
  left_by TEXT,
  cancelled_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  CHECK (window_until > window_from),
  CHECK ((left_at IS NULL) = (left_by IS NULL))
);
CREATE INDEX visitors_window ON visitors (org_id, mode, window_from DESC);

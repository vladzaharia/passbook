-- Trust pack: retention floors, legal holds, receipts, holder data requests.

-- A shortened retention keeps the old days until `until` (7 days), so a mistaken save cannot wipe data at once.
CREATE TABLE retention_floors (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  class TEXT NOT NULL,
  days INTEGER NOT NULL CHECK (days > 0),
  until INTEGER NOT NULL,
  PRIMARY KEY (org_id, class)
);

-- pass_id NULL holds the whole org. No FK on pass_id: a hold must outlive the pass it protected.
CREATE TABLE retention_holds (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  pass_id TEXT,
  placed_by_kind TEXT NOT NULL CHECK (placed_by_kind IN ('org', 'platform')),
  placed_by TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  released_by TEXT
);
CREATE INDEX retention_holds_active ON retention_holds (org_id, pass_id) WHERE released_at IS NULL;
-- Only a release may change a row, once; the app checks who may release a platform hold.
CREATE TRIGGER retention_holds_immutable BEFORE UPDATE ON retention_holds
WHEN OLD.released_at IS NOT NULL
  OR NEW.id IS NOT OLD.id
  OR NEW.org_id IS NOT OLD.org_id
  OR NEW.pass_id IS NOT OLD.pass_id
  OR NEW.placed_by_kind IS NOT OLD.placed_by_kind
  OR NEW.placed_by IS NOT OLD.placed_by
  OR NEW.reason IS NOT OLD.reason
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'retention hold is immutable');
END;
CREATE TRIGGER retention_holds_no_delete BEFORE DELETE ON retention_holds
WHEN EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'release a hold, never delete it');
END;

-- Append-only, MAC-chained per (org_id, class). org_id NULL is the platform pass. Counts only, never ids or content.
CREATE TABLE retention_receipts (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  class TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sweep', 'visitor', 'erasure')),
  policy_days INTEGER,
  cutoff_at INTEGER,
  deleted INTEGER NOT NULL,
  anonymised INTEGER NOT NULL DEFAULT 0,
  request_id TEXT,
  refs_digest TEXT,
  ran_at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  prev_mac TEXT,
  mac TEXT NOT NULL
);
-- Two chain heads for the platform pass (NULL org) must not coexist: the key uses '' for it.
CREATE UNIQUE INDEX retention_receipts_chain ON retention_receipts (ifnull(org_id, ''), class, seq);
CREATE INDEX retention_receipts_ran ON retention_receipts (ran_at);

-- The last receipt removed from a chain, so the chain verifies from it after the 6-year sweep.
CREATE TABLE retention_receipt_anchors (
  org_id TEXT,
  class TEXT NOT NULL,
  seq INTEGER NOT NULL,
  mac TEXT NOT NULL
);
CREATE UNIQUE INDEX retention_receipt_anchors_chain ON retention_receipt_anchors (ifnull(org_id, ''), class);

CREATE TRIGGER retention_receipts_no_update BEFORE UPDATE ON retention_receipts
BEGIN
  SELECT RAISE(ABORT, 'retention receipt is immutable');
END;
-- Older than 6 years and already covered by an anchor at or past it.
CREATE TRIGGER retention_receipts_no_delete BEFORE DELETE ON retention_receipts
WHEN OLD.ran_at >= CAST(unixepoch('subsec') * 1000 AS INTEGER) - 189216000000
  OR NOT EXISTS (
    SELECT 1 FROM retention_receipt_anchors a
    WHERE ifnull(a.org_id, '') = ifnull(OLD.org_id, '') AND a.class = OLD.class AND a.seq >= OLD.seq)
BEGIN
  SELECT RAISE(ABORT, 'retention receipt is immutable');
END;

CREATE TABLE data_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  contact_email TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('export', 'erasure')),
  state TEXT NOT NULL CHECK (state IN ('open', 'erasing', 'on_hold', 'done', 'declined', 'withdrawn')),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  response TEXT CHECK (response IS NULL OR length(response) <= 500),
  decline_reason TEXT,
  export_key TEXT,
  created_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  extended_at INTEGER,
  closed_at INTEGER,
  closed_by TEXT,
  row_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX data_requests_org ON data_requests (org_id, state, due_at);
CREATE INDEX data_requests_user ON data_requests (user_id, created_at DESC);
CREATE UNIQUE INDEX data_requests_one_open ON data_requests (org_id, user_id, kind)
  WHERE state IN ('open', 'erasing', 'on_hold');

CREATE TABLE data_request_passes (
  request_id TEXT NOT NULL REFERENCES data_requests (id) ON DELETE CASCADE,
  pass_ref TEXT NOT NULL,
  pass_id TEXT REFERENCES passes (id) ON DELETE SET NULL,
  purged_at INTEGER,
  PRIMARY KEY (request_id, pass_ref)
);
CREATE INDEX data_request_passes_pass ON data_request_passes (pass_id) WHERE pass_id IS NOT NULL;

CREATE INDEX pass_events_org_at ON pass_events (org_id, at);

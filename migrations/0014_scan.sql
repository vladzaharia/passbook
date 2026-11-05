-- Scanner: events, staff, scanners, scans, gates, NFC reader keys, desk lookup; audit gains the scanner actor.

CREATE TABLE scan_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  name TEXT NOT NULL,
  match_input TEXT,
  match_values TEXT CHECK (match_values IS NULL OR json_valid(match_values)),
  opens_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  time_zone TEXT NOT NULL,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  reentry INTEGER NOT NULL DEFAULT 0 CHECK (reentry IN (0, 1)),
  note TEXT CHECK (note IS NULL OR length(note) <= 140),   -- staff note; the only display-adjacent event field
  expected INTEGER,                -- cached denominator, refreshed at most once a minute
  expected_at INTEGER,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (closes_at > opens_at),
  CHECK ((match_input IS NULL) = (match_values IS NULL))
);
CREATE INDEX scan_events_org ON scan_events (org_id, mode, opens_at DESC);
CREATE INDEX scan_events_created_by ON scan_events (created_by);

CREATE TABLE scan_event_templates (
  event_id TEXT NOT NULL REFERENCES scan_events (id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, template_id)
);
CREATE INDEX scan_event_templates_template ON scan_event_templates (template_id);

CREATE TABLE scan_staff (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('door', 'desk', 'manager')),
  pin_hash TEXT NOT NULL,          -- HMAC-SHA256(K_pin, id:pin)
  pin_set_at INTEGER NOT NULL,
  disabled_at INTEGER,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX scan_staff_org_name ON scan_staff (org_id, name COLLATE NOCASE) WHERE disabled_at IS NULL;
CREATE INDEX scan_staff_org ON scan_staff (org_id, role, name COLLATE NOCASE);
CREATE INDEX scan_staff_created_by ON scan_staff (created_by);

CREATE TABLE scanners (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  kind TEXT NOT NULL CHECK (kind IN ('device', 'terminal', 'display')),  -- a display never scans; a terminal always does
  device_role TEXT NOT NULL DEFAULT 'scan' CHECK (device_role IN ('scan', 'customer', 'monitor')),
  name TEXT NOT NULL,
  event_id TEXT REFERENCES scan_events (id) ON DELETE SET NULL,
  settings TEXT NOT NULL CHECK (json_valid(settings)),
  time_zone TEXT NOT NULL,
  token_prefix TEXT UNIQUE,
  token_hash TEXT,
  csrf_secret TEXT,
  pair_code_hash TEXT UNIQUE,
  pair_expires_at INTEGER,
  pair_created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  paired_at INTEGER,
  paired_label TEXT,               -- "iPhone · Safari", parsed from the user agent
  expires_at INTEGER,
  last_seen_at INTEGER,
  last_ip_prefix TEXT,
  staff_id TEXT REFERENCES scan_staff (id) ON DELETE SET NULL,
  staff_since INTEGER,
  staff_seen_at INTEGER,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((token_hash IS NULL) = (token_prefix IS NULL)),
  CHECK (kind <> 'terminal' OR csrf_secret IS NULL),
  CHECK (kind <> 'terminal' OR device_role = 'scan'),
  CHECK (kind <> 'display' OR device_role <> 'scan')
);
CREATE UNIQUE INDEX scanners_org_name ON scanners (org_id, mode, name COLLATE NOCASE) WHERE revoked_at IS NULL;
CREATE INDEX scanners_org ON scanners (org_id, mode, id DESC);
CREATE INDEX scanners_event ON scanners (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX scanners_staff ON scanners (staff_id) WHERE staff_id IS NOT NULL;
CREATE INDEX scanners_created_by ON scanners (created_by);
CREATE INDEX scanners_pair_created_by ON scanners (pair_created_by);

CREATE TABLE scanner_templates (
  scanner_id TEXT NOT NULL REFERENCES scanners (id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  PRIMARY KEY (scanner_id, template_id)
);
CREATE INDEX scanner_templates_template ON scanner_templates (template_id);

-- One row per scan request: the record, the idempotency key and the undo link. Holds no holder data.
-- scanner_id, event_id and staff_id are not foreign keys: proof outlives configuration.
CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  pass_id TEXT REFERENCES passes (id) ON DELETE SET NULL,
  template_id TEXT,
  scanner_id TEXT,
  event_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('scanner', 'user', 'system')),
  actor_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  staff_id TEXT,
  approved_by TEXT,                -- scan_staff id of the approving Manager
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('camera', 'wedge', 'nfc', 'manual', 'auto')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
  outcome TEXT CHECK (outcome IN ('ok', 'heads_up', 'refused')),
  reason TEXT,
  action_id TEXT,
  action_kind TEXT CHECK (action_kind IN ('check_in', 'add', 'take', 'set', 'use_up', 'undo')),
  direction TEXT CHECK (direction IS NULL OR direction IN ('in', 'out')),
  amount REAL,
  before_value TEXT CHECK (before_value IS NULL OR json_valid(before_value)),
  after_value TEXT CHECK (after_value IS NULL OR json_valid(after_value)),
  override_of TEXT,
  group_id TEXT,
  offline INTEGER NOT NULL DEFAULT 0,
  pass_version INTEGER,
  notified INTEGER NOT NULL DEFAULT 0,
  undoes TEXT,
  undone_by TEXT,
  undone_at INTEGER,
  client_ts INTEGER,
  at INTEGER NOT NULL
);
CREATE UNIQUE INDEX scans_idem ON scans (actor_key, idempotency_key);
CREATE INDEX scans_pass ON scans (pass_id, at DESC);
CREATE INDEX scans_org ON scans (org_id, mode, at DESC);
CREATE INDEX scans_scanner ON scans (scanner_id, at DESC);
CREATE INDEX scans_actor ON scans (actor_key, at DESC, outcome);
CREATE INDEX scans_event ON scans (event_id, at DESC) WHERE event_id IS NOT NULL;
CREATE INDEX scans_staff ON scans (staff_id, at DESC) WHERE staff_id IS NOT NULL;
CREATE INDEX scans_mode_at ON scans (mode, at);
CREATE INDEX scans_pending ON scans (at) WHERE state = 'pending';
CREATE INDEX scans_undoes ON scans (undoes) WHERE undoes IS NOT NULL;
-- Display history (4.6): visits, last visit and the value ledger. Undone rows are filtered as a residual.
CREATE INDEX scans_pass_ok ON scans (pass_id, action_kind, at DESC) WHERE outcome = 'ok';

-- The gate: one row per pass, action and scope ('' | 'event:<id>' | 'day:<yyyy-mm-dd>').
-- An UPSERT with a WHERE on the update is the atomic first-scan-wins, cooldown and in/out check.
CREATE TABLE scan_gates (
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  template_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in', 'out', 'used', 'undone')),
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  last_scan_id TEXT NOT NULL,
  prev_state TEXT,
  prev_last_at INTEGER,
  prev_scan_id TEXT,
  PRIMARY KEY (pass_id, action_id, scope)
) WITHOUT ROWID;
CREATE INDEX scan_gates_count ON scan_gates (org_id, mode, scope, kind, state, template_id);

-- Apple VAS reader keys: the public half only. The browser makes the pair; the admin keeps the private key.
CREATE TABLE vas_keys (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES signing_identities (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,        -- base64 SPKI, P-256
  key_id TEXT NOT NULL,            -- 4 bytes hex, what the reader sees
  state TEXT NOT NULL CHECK (state IN ('active', 'retiring', 'retired')),
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,
  retired_at INTEGER
);
CREATE UNIQUE INDEX vas_keys_active ON vas_keys (identity_id, org_id) WHERE state = 'active';
CREATE INDEX vas_keys_org ON vas_keys (org_id, identity_id, state);
CREATE INDEX vas_keys_created_by ON vas_keys (created_by);

-- Desk lookup by member, card or ticket number: SHA-256 of normalizeLookup(value of manifest.scan.lookup.input).
ALTER TABLE passes ADD COLUMN lookup_hash TEXT;
CREATE INDEX passes_lookup_hash ON passes (org_id, lookup_hash) WHERE lookup_hash IS NOT NULL;
-- Name search within one org and mode (the 0003 NOCASE indexes span every tenant).
CREATE INDEX passes_org_title ON passes (org_id, mode, display_title COLLATE NOCASE);
CREATE INDEX passes_org_subtitle ON passes (org_id, mode, display_subtitle COLLATE NOCASE);

-- audit_log: add 'scanner'. Safe rebuild: no table references it.
CREATE TABLE audit_log_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  org_id TEXT,
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('user', 'api_key', 'system', 'connection', 'device', 'scanner')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  request_id TEXT,
  ip_prefix TEXT,
  detail TEXT CHECK (detail IS NULL OR json_valid(detail))
);
INSERT INTO audit_log_next (id, at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
  SELECT id, at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_next RENAME TO audit_log;
CREATE INDEX audit_org ON audit_log (org_id, at DESC);
CREATE INDEX audit_target ON audit_log (target_type, target_id, at DESC);
CREATE INDEX audit_at ON audit_log (at);
CREATE INDEX audit_actor ON audit_log (actor_id, id DESC);
CREATE INDEX audit_action ON audit_log (action COLLATE NOCASE, id DESC);

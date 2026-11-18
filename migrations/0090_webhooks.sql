-- Outbound webhooks and the event feed (PS-10).

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  url TEXT NOT NULL CHECK (length(url) <= 2048 AND substr(url, 1, 8) = 'https://'),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 120),
  event_types TEXT NOT NULL CHECK (json_valid(event_types) AND json_type(event_types) = 'array'
    AND json_array_length(event_types) BETWEEN 1 AND 32),
  template_ids TEXT CHECK (template_ids IS NULL OR (json_valid(template_ids)
    AND json_type(template_ids) = 'array' AND json_array_length(template_ids) BETWEEN 1 AND 20)),
  api_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  disabled_at INTEGER,
  failing_since INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at INTEGER,
  last_failure_at INTEGER,
  lane_token TEXT,
  lane_until INTEGER,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, org_id, mode),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);
CREATE INDEX webhook_endpoints_org ON webhook_endpoints (org_id, mode, status);
CREATE INDEX webhook_endpoints_created_by ON webhook_endpoints (created_by);

CREATE TRIGGER webhook_endpoints_cap BEFORE INSERT ON webhook_endpoints
WHEN (SELECT count(*) FROM webhook_endpoints WHERE org_id = NEW.org_id AND mode = NEW.mode) >= 10
BEGIN SELECT RAISE(ABORT, 'webhook endpoint limit'); END;
CREATE TRIGGER webhook_endpoints_identity BEFORE UPDATE ON webhook_endpoints
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'immutable webhook endpoint identity'); END;

-- Append-only except a rewrap (kek_version, wrapped_dek) and one expiry.
CREATE TABLE webhook_endpoint_secrets (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  kek_version INTEGER NOT NULL CHECK (kek_version > 0),
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                       -- NULL = current
  FOREIGN KEY (endpoint_id, org_id, mode) REFERENCES webhook_endpoints (id, org_id, mode) ON DELETE CASCADE
);
CREATE INDEX webhook_endpoint_secrets_fk ON webhook_endpoint_secrets (endpoint_id, org_id, mode);
CREATE UNIQUE INDEX webhook_endpoint_secrets_current ON webhook_endpoint_secrets (endpoint_id) WHERE expires_at IS NULL;
CREATE TRIGGER webhook_endpoint_secrets_immutable BEFORE UPDATE ON webhook_endpoint_secrets
WHEN NEW.id IS NOT OLD.id OR NEW.endpoint_id IS NOT OLD.endpoint_id OR NEW.org_id IS NOT OLD.org_id
  OR NEW.mode IS NOT OLD.mode OR NEW.iv IS NOT OLD.iv OR NEW.ciphertext IS NOT OLD.ciphertext
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.expires_at IS NOT NULL AND NEW.expires_at IS NOT OLD.expires_at AND NEW.expires_at > OLD.expires_at)
BEGIN SELECT RAISE(ABORT, 'immutable webhook secret'); END;

-- The journal: one row per catalog event, in commit order. Written only by the trigger below.
CREATE TABLE event_feed (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  external_id TEXT,
  type TEXT NOT NULL,
  kind TEXT NOT NULL,
  device TEXT,
  device_count INTEGER,
  actor_type TEXT,
  data TEXT NOT NULL CHECK (json_valid(data)),
  at INTEGER NOT NULL,
  UNIQUE (seq, org_id, mode)
);
CREATE INDEX event_feed_org ON event_feed (org_id, mode, seq);
CREATE INDEX event_feed_org_type ON event_feed (org_id, mode, type, seq);
CREATE INDEX event_feed_pass ON event_feed (pass_id);
CREATE INDEX event_feed_at ON event_feed (at);
CREATE TRIGGER event_feed_no_update BEFORE UPDATE ON event_feed
BEGIN SELECT RAISE(ABORT, 'append-only event feed'); END;

CREATE TABLE webhook_deliveries (
  endpoint_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_at INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  last_attempt_at INTEGER,
  finished_at INTEGER,
  replays INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (endpoint_id, event_seq),
  FOREIGN KEY (endpoint_id, org_id, mode) REFERENCES webhook_endpoints (id, org_id, mode) ON DELETE CASCADE,
  FOREIGN KEY (event_seq, org_id, mode) REFERENCES event_feed (seq, org_id, mode) ON DELETE CASCADE,
  CHECK ((state = 'pending') = (finished_at IS NULL))
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (endpoint_id, next_at, event_seq) WHERE state = 'pending';
CREATE INDEX webhook_deliveries_due_all ON webhook_deliveries (next_at) WHERE state = 'pending';
CREATE INDEX webhook_deliveries_endpoint_fk ON webhook_deliveries (endpoint_id, org_id, mode);
CREATE INDEX webhook_deliveries_event_fk ON webhook_deliveries (event_seq, org_id, mode);
CREATE INDEX webhook_deliveries_finished ON webhook_deliveries (finished_at) WHERE finished_at IS NOT NULL;
CREATE TRIGGER webhook_deliveries_key BEFORE UPDATE ON webhook_deliveries
WHEN NEW.endpoint_id IS NOT OLD.endpoint_id OR NEW.event_seq IS NOT OLD.event_seq
  OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
BEGIN SELECT RAISE(ABORT, 'immutable webhook delivery key'); END;

CREATE TABLE webhook_attempts (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  event_seq INTEGER,                        -- NULL for a test send
  attempt INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('event', 'retry', 'replay', 'test')),
  status INTEGER,
  error_code TEXT,
  duration_ms INTEGER NOT NULL,
  at INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id, org_id, mode) REFERENCES webhook_endpoints (id, org_id, mode) ON DELETE CASCADE,
  FOREIGN KEY (event_seq, org_id, mode) REFERENCES event_feed (seq, org_id, mode) ON DELETE CASCADE
);
CREATE INDEX webhook_attempts_delivery ON webhook_attempts (endpoint_id, event_seq, at DESC);
CREATE INDEX webhook_attempts_endpoint_fk ON webhook_attempts (endpoint_id, org_id, mode);
CREATE INDEX webhook_attempts_event_fk ON webhook_attempts (event_seq, org_id, mode);
CREATE INDEX webhook_attempts_at ON webhook_attempts (at);

-- Journal and fan-out, in the ledger write's own transaction. The org and mode come from the pass row.
CREATE TRIGGER pass_events_feed AFTER INSERT ON pass_events
WHEN NEW.kind IN ('pass.issued', 'pass.updated', 'pass.voided', 'pass.unvoided', 'pass.removed',
    'pass.restored', 'device.registered', 'device.unregistered', 'scan.checked_in', 'scan.redeemed',
    'scan.adjusted', 'scan.checked_out', 'scan.heads_up', 'scan.rejected', 'scan.undone',
    'push.failed', 'email.failed')
  AND NOT (NEW.kind = 'pass.updated' AND json_extract(NEW.data, '$.cause') = 'resign')
  AND NOT EXISTS (SELECT 1 FROM settings WHERE scope = 'platform' AND key = 'events.feed' AND value = '"off"')
BEGIN
  INSERT OR IGNORE INTO event_feed (event_id, org_id, mode, pass_id, template_id, external_id, type,
    kind, device, device_count, actor_type, data, at)
  SELECT NEW.id, p.org_id, p.mode, p.id, p.template_id, p.external_id,
    CASE NEW.kind
      WHEN 'device.registered' THEN 'pass.installed'
      WHEN 'device.unregistered' THEN 'pass.uninstalled'
      WHEN 'scan.rejected' THEN 'pass.scan_refused'
      WHEN 'scan.undone' THEN 'pass.scan_undone'
      WHEN 'scan.checked_in' THEN 'pass.scanned' WHEN 'scan.redeemed' THEN 'pass.scanned'
      WHEN 'scan.adjusted' THEN 'pass.scanned' WHEN 'scan.checked_out' THEN 'pass.scanned'
      WHEN 'scan.heads_up' THEN 'pass.scanned'
      ELSE NEW.kind END,
    NEW.kind, NEW.device,
    CASE WHEN NEW.kind IN ('device.registered', 'device.unregistered')
      THEN (SELECT count(*) FROM registrations r WHERE r.pass_id = p.id) END,
    NEW.actor_type, NEW.data, NEW.at
  FROM passes p JOIN orgs o ON o.id = p.org_id AND o.status = 'active'
  WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode
    AND p.deleted_at IS NULL AND p.test_data_quarantined = 0;

  INSERT OR IGNORE INTO webhook_deliveries (endpoint_id, event_seq, org_id, mode)
  SELECT e.id, f.seq, f.org_id, f.mode
  FROM event_feed f
  JOIN webhook_endpoints e ON e.org_id = f.org_id AND e.mode = f.mode
  WHERE f.event_id = NEW.id
    AND e.status IN ('active', 'paused')
    AND EXISTS (SELECT 1 FROM json_each(e.event_types) t WHERE t.value = f.type)
    AND (e.template_ids IS NULL
      OR EXISTS (SELECT 1 FROM json_each(e.template_ids) t WHERE t.value = f.template_id));
END;

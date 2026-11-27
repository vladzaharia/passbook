-- Workbench device passes: a Test pass of a developer's own sandbox on their phone, signed under the
-- device-test identity. Behind DEVICE_PASS_ENABLED (off). The serial is 'dp_' || id.
CREATE TABLE device_passes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'voided', 'expired')),
  void_reason TEXT CHECK (void_reason IS NULL OR void_reason IN
    ('developer', 'expired', 'overshared', 'platform', 'pass_gone')),
  -- The web service token is derived from the id and this nonce under a server key; it is never stored.
  auth_nonce TEXT NOT NULL,
  -- SHA-256 of the single-use download code, 10 minutes. Null once used.
  code_hash TEXT UNIQUE,
  code_expires_at INTEGER,
  code_used_at INTEGER,
  codes_issued INTEGER NOT NULL DEFAULT 1 CHECK (codes_issued BETWEEN 1 AND 5),
  again_of TEXT REFERENCES device_passes (id) ON DELETE SET NULL,
  -- The source pass version the device copy was last rebuilt for.
  source_version INTEGER NOT NULL,
  -- SHA-256 of the pass.json last signed; the pass itself is never kept.
  pass_json_hash TEXT,
  -- The tag a device reads with passesUpdatedSince: ms, strictly increasing per row.
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  downloaded_at INTEGER,
  -- The last time a phone registered or fetched it.
  last_seen_at INTEGER,
  voided_at INTEGER,
  CHECK ((voided_at IS NULL) = (state NOT IN ('voided', 'expired')))
);
CREATE INDEX device_passes_org_open ON device_passes (org_id, state, expires_at);
CREATE INDEX device_passes_pass ON device_passes (pass_id, state);
CREATE INDEX device_passes_user ON device_passes (user_id, created_at DESC);
CREATE INDEX device_passes_again_of ON device_passes (again_of);
CREATE INDEX device_passes_expiry ON device_passes (expires_at) WHERE state IN ('pending', 'active');

CREATE TRIGGER device_passes_tenant BEFORE INSERT ON device_passes
WHEN NOT EXISTS (SELECT 1 FROM passes WHERE id = NEW.pass_id AND org_id = NEW.org_id AND mode = 'test')
BEGIN SELECT RAISE(ABORT, 'device pass tenant'); END;

CREATE TRIGGER device_passes_fixed BEFORE UPDATE ON device_passes
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.pass_id IS NOT OLD.pass_id
  OR NEW.user_id IS NOT OLD.user_id OR NEW.auth_nonce IS NOT OLD.auth_nonce
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.state IN ('voided', 'expired') AND NEW.state IS NOT OLD.state)
BEGIN SELECT RAISE(ABORT, 'immutable device pass'); END;

-- The phones that registered a device pass (at most 3 distinct; a fourth voids it).
CREATE TABLE device_pass_devices (
  device_pass_id TEXT NOT NULL REFERENCES device_passes (id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  push_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (device_pass_id, device_id)
);

-- A developer whose device passes were shared: no new ones until a platform admin clears the row.
CREATE TABLE device_pass_blocks (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('overshared')),
  created_at INTEGER NOT NULL
);

-- The feed trigger of 0239, counting the phones of a device pass as devices of a Test pass.
DROP TRIGGER pass_events_feed;
CREATE TRIGGER pass_events_feed AFTER INSERT ON pass_events
WHEN NEW.kind IN ('pass.issued', 'pass.updated', 'pass.voided', 'pass.unvoided', 'pass.removed',
    'pass.restored', 'device.registered', 'device.unregistered', 'scan.checked_in', 'scan.redeemed',
    'scan.adjusted', 'scan.checked_out', 'scan.heads_up', 'scan.rejected', 'scan.undone',
    'push.failed', 'email.failed', 'pass.channels_changed', 'pass.printed', 'pass.print_voided', 'pass.replaced')
  AND NOT (NEW.kind = 'pass.updated' AND json_extract(NEW.data, '$.cause') IS 'resign')
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
      THEN (SELECT count(*) FROM registrations r WHERE r.pass_id = p.id
        AND r.credential_generation = p.credential_generation)
        -- Simulated devices count in Test only, Live counts real registrations (0238).
        + CASE WHEN p.mode = 'test' THEN (SELECT count(*) FROM pass_simulated_devices s
          WHERE s.pass_id = p.id AND s.removed_at IS NULL) ELSE 0 END
        -- The developer's own phones holding an open device pass of the pass count in Test too (0244).
        + CASE WHEN p.mode = 'test' THEN (SELECT count(*) FROM device_pass_devices x
          JOIN device_passes d ON d.id = x.device_pass_id
          WHERE d.pass_id = p.id AND d.state IN ('pending', 'active')) ELSE 0 END END,
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

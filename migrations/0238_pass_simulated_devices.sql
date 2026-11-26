-- Workbench simulate: devices that exist only as Test rows, merged into a pass's devices view.
CREATE TABLE pass_simulated_devices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'apple' CHECK (platform IN ('apple')),
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE INDEX pass_simulated_devices_pass ON pass_simulated_devices (pass_id, created_at DESC);
CREATE INDEX pass_simulated_devices_org ON pass_simulated_devices (org_id);

-- Test passes of the same org only.
CREATE TRIGGER pass_simulated_devices_tenant BEFORE INSERT ON pass_simulated_devices
WHEN NOT EXISTS (SELECT 1 FROM passes WHERE id = NEW.pass_id AND org_id = NEW.org_id AND mode = 'test')
BEGIN SELECT RAISE(ABORT, 'simulated device tenant'); END;
CREATE TRIGGER pass_simulated_devices_identity BEFORE UPDATE ON pass_simulated_devices
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.pass_id IS NOT OLD.pass_id
  OR NEW.created_at IS NOT OLD.created_at OR (OLD.removed_at IS NOT NULL AND NEW.removed_at IS NOT OLD.removed_at)
BEGIN SELECT RAISE(ABORT, 'immutable simulated device'); END;

-- The feed trigger of 0109, with Test device counts that include simulated devices.
DROP TRIGGER pass_events_feed;
CREATE TRIGGER pass_events_feed AFTER INSERT ON pass_events
WHEN NEW.kind IN ('pass.issued', 'pass.updated', 'pass.voided', 'pass.unvoided', 'pass.removed',
    'pass.restored', 'device.registered', 'device.unregistered', 'scan.checked_in', 'scan.redeemed',
    'scan.adjusted', 'scan.checked_out', 'scan.heads_up', 'scan.rejected', 'scan.undone',
    'push.failed', 'email.failed', 'pass.channels_changed', 'pass.printed', 'pass.print_voided')
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
        -- Simulated devices count in Test only, Live counts real registrations.
        + CASE WHEN p.mode = 'test' THEN (SELECT count(*) FROM pass_simulated_devices s
          WHERE s.pass_id = p.id AND s.removed_at IS NULL) ELSE 0 END END,
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

-- Delivery channels. A template's policy per (org, mode, template); a pass's override and retirement
-- per channel; copy evidence in its own insert-once table (outside the scan fence, N3).

CREATE TABLE template_channel_policies (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  template_id TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  channels TEXT NOT NULL CHECK (json_valid(channels) AND json_type(channels) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, mode, template_id)
) WITHOUT ROWID;
CREATE INDEX template_channel_policies_template ON template_channel_policies (template_id);

-- The template is the org's own, or an active baked or shared platform template (not a blueprint).
CREATE TRIGGER template_channel_policies_tenant BEFORE INSERT ON template_channel_policies
WHEN NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = NEW.template_id AND (t.org_id = NEW.org_id
    OR (t.org_id IS NULL AND (t.origin = 'baked' OR t.shared = 1) AND t.blueprint = 0 AND t.status = 'active')))
BEGIN SELECT RAISE(ABORT, 'channel_policy_tenant'); END;
CREATE TRIGGER template_channel_policies_key BEFORE UPDATE ON template_channel_policies
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode OR NEW.template_id IS NOT OLD.template_id
BEGIN SELECT RAISE(ABORT, 'channel_policy_key'); END;

-- A policy change is a settings change: it moves the org's config_revision.
CREATE TRIGGER template_channel_policies_config_ins AFTER INSERT ON template_channel_policies
BEGIN UPDATE orgs SET config_revision = config_revision + 1 WHERE id = NEW.org_id; END;
CREATE TRIGGER template_channel_policies_config_upd AFTER UPDATE ON template_channel_policies
BEGIN UPDATE orgs SET config_revision = config_revision + 1 WHERE id = NEW.org_id; END;
CREATE TRIGGER template_channel_policies_config_del AFTER DELETE ON template_channel_policies
BEGIN UPDATE orgs SET config_revision = config_revision + 1 WHERE id = OLD.org_id; END;

-- override NULL: follows the template. retired_at: a plain Turn off retired this pass's copies.
CREATE TABLE pass_channels (
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  template_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('mobile', 'apple', 'google', 'samsung', 'paper', 'nfc')),
  override TEXT CHECK (override IN ('on', 'off')),
  retired_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (pass_id, channel)
) WITHOUT ROWID;
CREATE INDEX pass_channels_template ON pass_channels (org_id, mode, template_id, channel);

CREATE TRIGGER pass_channels_tenant BEFORE INSERT ON pass_channels
WHEN NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id
  AND p.mode = NEW.mode AND p.template_id = NEW.template_id)
BEGIN SELECT RAISE(ABORT, 'pass_channel_tenant'); END;
CREATE TRIGGER pass_channels_key BEFORE UPDATE ON pass_channels
WHEN NEW.pass_id IS NOT OLD.pass_id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
  OR NEW.template_id IS NOT OLD.template_id OR NEW.channel IS NOT OLD.channel
BEGIN SELECT RAISE(ABORT, 'pass_channel_key'); END;

-- pass_channels.template_id copies the pass's; neither it nor the mode may move while rows exist.
CREATE TRIGGER passes_channels_key BEFORE UPDATE OF template_id, mode ON passes
WHEN (NEW.template_id IS NOT OLD.template_id OR NEW.mode IS NOT OLD.mode)
  AND EXISTS (SELECT 1 FROM pass_channels c WHERE c.pass_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'pass_channels_key'); END;

-- Evidence that a copy exists in a channel; written once, never moved.
CREATE TABLE pass_channel_copies (
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  channel TEXT NOT NULL CHECK (channel IN ('mobile', 'apple', 'google', 'samsung', 'paper', 'nfc')),
  copy_at INTEGER NOT NULL,
  PRIMARY KEY (pass_id, channel)
) WITHOUT ROWID;

CREATE TRIGGER pass_channel_copies_tenant BEFORE INSERT ON pass_channel_copies
WHEN NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode)
BEGIN SELECT RAISE(ABORT, 'pass_channel_copy_tenant'); END;
CREATE TRIGGER pass_channel_copies_once BEFORE UPDATE ON pass_channel_copies
BEGIN SELECT RAISE(ABORT, 'pass_channel_copy_immutable'); END;

-- Channel changes join the journal and the webhook feed (the trigger of 0090 with three more kinds).
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
        AND r.credential_generation = p.credential_generation) END,
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

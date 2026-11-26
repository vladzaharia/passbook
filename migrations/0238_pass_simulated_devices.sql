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

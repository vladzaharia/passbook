-- Remote tag enrollment: an admin asks a connected scanner to read a tag for a pass. The row is the truth;
-- the ScanHub only rings the device. One pending request per scanner and per pass; a request lasts at most 120 s.

CREATE TABLE tag_enrollments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  scanner_id TEXT NOT NULL REFERENCES scanners (id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('pass', 'user')),
  -- The pass owner at request time, user scope only.
  user_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'cancelled', 'declined', 'expired', 'failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at - created_at BETWEEN 1 AND 120000),
  -- The device fetched the request and shows it.
  shown_at INTEGER,
  ended_at INTEGER,
  binding_id TEXT REFERENCES tag_bindings (id) ON DELETE SET NULL,
  error_code TEXT,
  CHECK ((scope = 'user') = (user_id IS NOT NULL)),
  CHECK ((state = 'pending') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX tag_enrollments_scanner ON tag_enrollments (scanner_id) WHERE state = 'pending';
CREATE UNIQUE INDEX tag_enrollments_pass ON tag_enrollments (pass_id) WHERE state = 'pending';
CREATE INDEX tag_enrollments_org ON tag_enrollments (org_id, mode, created_at);
CREATE INDEX tag_enrollments_ended ON tag_enrollments (ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX tag_enrollments_binding ON tag_enrollments (binding_id) WHERE binding_id IS NOT NULL;

-- Insert: scanner and pass belong to the row's tenant, the pass is live, a user scope names the pass's owner.
CREATE TRIGGER tag_enrollments_insert_check BEFORE INSERT ON tag_enrollments
BEGIN
  SELECT RAISE(ABORT, 'enrollment_pending') WHERE NEW.state <> 'pending';
  SELECT RAISE(ABORT, 'enrollment_tenant') WHERE NOT EXISTS (
    SELECT 1 FROM passes p JOIN scanners s ON s.org_id = p.org_id AND s.mode = p.mode
    WHERE p.id = NEW.pass_id AND s.id = NEW.scanner_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode
      AND p.deleted_at IS NULL AND s.revoked_at IS NULL AND s.device_role = 'scan' AND s.kind = 'device');
  SELECT RAISE(ABORT, 'enrollment_owner') WHERE NEW.scope = 'user'
    AND NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.owner_user_id = NEW.user_id);
END;

-- Update: identity columns never change; a pending request leaves 'pending' once; shown_at is set once.
CREATE TRIGGER tag_enrollments_update_check BEFORE UPDATE ON tag_enrollments
BEGIN
  SELECT RAISE(ABORT, 'enrollment_immutable') WHERE OLD.state <> 'pending'
    OR NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
    OR NEW.pass_id IS NOT OLD.pass_id OR NEW.scanner_id IS NOT OLD.scanner_id
    OR NEW.requested_by IS NOT OLD.requested_by OR NEW.scope IS NOT OLD.scope
    OR NEW.user_id IS NOT OLD.user_id OR NEW.created_at IS NOT OLD.created_at
    OR NEW.expires_at IS NOT OLD.expires_at
    OR (OLD.shown_at IS NOT NULL AND NEW.shown_at IS NOT OLD.shown_at);
END;

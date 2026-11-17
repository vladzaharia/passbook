-- Triggers that ran on every update now run only when a guarded column is written. Same checks,
-- same messages: an update that leaves the keys alone cannot collide with another row.

DROP TRIGGER scanners_revision_no_replace_update;
CREATE TRIGGER scanners_revision_no_replace_update
BEFORE UPDATE OF id, token_prefix, pair_code_hash, org_id, mode, name, revoked_at ON scanners
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM scanners WHERE id = NEW.id AND rowid != OLD.rowid)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanners.id') END;
  SELECT CASE WHEN NEW.token_prefix IS NOT NULL AND EXISTS
    (SELECT 1 FROM scanners WHERE token_prefix = NEW.token_prefix AND rowid != OLD.rowid)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanners.token_prefix') END;
  SELECT CASE WHEN NEW.pair_code_hash IS NOT NULL AND EXISTS
    (SELECT 1 FROM scanners WHERE pair_code_hash = NEW.pair_code_hash AND rowid != OLD.rowid)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanners.pair_code_hash') END;
  SELECT CASE WHEN NEW.revoked_at IS NULL AND EXISTS
    (SELECT 1 FROM scanners WHERE org_id = NEW.org_id AND mode = NEW.mode
      AND name = NEW.name COLLATE NOCASE AND revoked_at IS NULL AND rowid != OLD.rowid)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanners.org_id, scanners.mode, scanners.name') END;
END;

DROP TRIGGER pass_credential_no_replace_update;
CREATE TRIGGER pass_credential_no_replace_update
BEFORE UPDATE OF id, download_token, identity_id, serial, scan_code, org_id, connection_id, external_ref ON passes
WHEN NEW.id IS NOT OLD.id OR NEW.download_token IS NOT OLD.download_token
  OR NEW.identity_id IS NOT OLD.identity_id OR NEW.serial IS NOT OLD.serial
  OR NEW.scan_code IS NOT OLD.scan_code OR NEW.org_id IS NOT OLD.org_id
  OR NEW.connection_id IS NOT OLD.connection_id OR NEW.external_ref IS NOT OLD.external_ref
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM passes p WHERE p.id IS NOT OLD.id AND p.id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.id') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM passes p WHERE p.id IS NOT OLD.id AND p.download_token = NEW.download_token)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.download_token') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM passes p WHERE p.id IS NOT OLD.id
    AND p.identity_id = NEW.identity_id AND p.serial = NEW.serial)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.identity_id, passes.serial') END;
  SELECT CASE WHEN NEW.scan_code IS NOT NULL
    AND EXISTS (SELECT 1 FROM passes p WHERE p.id IS NOT OLD.id AND p.scan_code = NEW.scan_code)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.scan_code') END;
  SELECT CASE WHEN NEW.connection_id IS NOT NULL AND NEW.external_ref IS NOT NULL
    AND EXISTS (SELECT 1 FROM passes p WHERE p.id IS NOT OLD.id AND p.org_id = NEW.org_id
      AND p.connection_id = NEW.connection_id AND p.external_ref = NEW.external_ref)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: passes.org_id, passes.connection_id, passes.external_ref') END;
END;

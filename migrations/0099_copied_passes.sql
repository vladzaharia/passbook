-- A new scan code (PS-28) replaces the code in place. It is the one credential change that is not a
-- transfer, so it needs a mark: a scan_code_rotations row for exactly the pass and the version the write
-- creates, inserted in the same batch. The row keeps the keyed hash of the code that was rotated out, so a
-- scan of it reads "replaced" rather than "not found". Marks are append-only and follow their pass.
CREATE TABLE scan_code_rotations (
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  old_code_hash TEXT NOT NULL CHECK (length(old_code_hash) = 64 AND old_code_hash NOT GLOB '*[^0-9a-f]*'),
  new_version INTEGER NOT NULL CHECK (typeof(new_version) = 'integer' AND new_version >= 1),
  rotated_at INTEGER NOT NULL CHECK (typeof(rotated_at) = 'integer' AND rotated_at >= 0),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  PRIMARY KEY (pass_id, new_version)
) WITHOUT ROWID;
CREATE INDEX scan_code_rotations_lookup ON scan_code_rotations (org_id, mode, old_code_hash);
CREATE TRIGGER scan_code_rotations_insert_guard BEFORE INSERT ON scan_code_rotations
WHEN NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id
  AND p.mode = NEW.mode AND p.scan_code IS NOT NULL AND p.version + 1 = NEW.new_version)
BEGIN SELECT RAISE(ABORT, 'invalid scan code rotation'); END;
CREATE TRIGGER scan_code_rotations_no_update BEFORE UPDATE ON scan_code_rotations
BEGIN SELECT RAISE(ABORT, 'scan code rotation is immutable'); END;
-- A cascade from a deleted pass runs after the pass row is gone; anything else is refused.
CREATE TRIGGER scan_code_rotations_no_delete BEFORE DELETE ON scan_code_rotations
WHEN EXISTS (SELECT 1 FROM passes p WHERE p.id = OLD.pass_id)
BEGIN SELECT RAISE(ABORT, 'scan code rotation is immutable'); END;

DROP TRIGGER pass_credential_transfer_required;
CREATE TRIGGER pass_credential_transfer_required
BEFORE UPDATE OF holder_email, owner_user_id, serial, auth_token, scan_code, identity_id, org_id, mode ON passes
WHEN NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = OLD.id AND t.state = 'pending')
  AND (NEW.holder_email IS NOT OLD.holder_email
    OR (NEW.owner_user_id IS NOT OLD.owner_user_id
      AND NOT (OLD.owner_user_id IS NULL AND NEW.owner_user_id IS NOT NULL
        AND NEW.deleted_at IS NULL AND NEW.test_data_quarantined = 0
        AND EXISTS (SELECT 1 FROM users u JOIN user_emails e ON e.user_id = u.id
          WHERE u.id = NEW.owner_user_id AND u.status = 'active' AND e.email = NEW.holder_email)
        AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = OLD.id AND b.user_id = NEW.owner_user_id))
      AND NOT (OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NULL
        AND EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = OLD.id AND b.user_id = OLD.owner_user_id)))
    OR NEW.serial IS NOT OLD.serial
    OR (NEW.auth_token IS NOT OLD.auth_token
      AND NOT ((EXISTS (SELECT 1 FROM token_remac_marks m WHERE m.pass_id = OLD.id AND m.kind = 'auth' AND m.mac = NEW.auth_token))
        AND NEW.credential_generation IS OLD.credential_generation))
    OR NEW.identity_id IS NOT OLD.identity_id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
    OR (OLD.scan_code IS NOT NULL AND NEW.scan_code IS NOT OLD.scan_code AND NOT EXISTS (SELECT 1 FROM scan_code_rotations r WHERE r.pass_id = OLD.id
      AND r.new_version = NEW.version AND NEW.version = OLD.version + 1)))
BEGIN SELECT RAISE(ABORT, 'credential transfer required'); END;

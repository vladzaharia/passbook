-- A new scan code replaces the code in place when the write is a new pass version (a publish).
-- Holder, serial, token and any other credential change still need a transfer.
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
    OR (OLD.scan_code IS NOT NULL AND NEW.scan_code IS NOT OLD.scan_code AND NEW.version <= OLD.version))
BEGIN SELECT RAISE(ABORT, 'credential transfer required'); END;

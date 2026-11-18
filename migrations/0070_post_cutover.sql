-- One release after the cutover. Nothing reads or writes scanning_config_revisions: config_epoch replaced it.
DROP TABLE scanning_config_revisions;

-- The token seal sweep finished in production (no plain pass or bundle token, no pass_versions row with a device token).
-- 0059 and 0065 let a plain token become a MAC without moving the link or the credential generation. That path
-- is gone: a plain value is refused (the *_is_mac_* triggers) and nothing may replace a MAC except a transfer, a
-- rotation or a token_remac_marks row naming exactly the new MAC. These six triggers are the 0069 versions with the
-- plain branch (`OLD.x NOT GLOB 'h1:*' AND NEW.x GLOB 'h1:*' OR`) deleted; everything else is unchanged. The
-- indexes were the seal sweep's work lists. The triggers that refuse a plain token or a pass_json with a device
-- token stay.
DROP INDEX passes_token_plain;
DROP INDEX passes_auth_plain;
DROP INDEX bundles_token_plain;
DROP INDEX pass_versions_auth_plain;

DROP TRIGGER passes_token_change_moves_link;
CREATE TRIGGER passes_token_change_moves_link BEFORE UPDATE OF download_token ON passes
WHEN NEW.download_token IS NOT OLD.download_token AND NEW.link_generation IS OLD.link_generation
  AND NOT ((EXISTS (SELECT 1 FROM token_remac_marks m WHERE m.pass_id = OLD.id AND m.kind = 'download' AND m.mac = NEW.download_token))
    AND NEW.download_token_rotated_at IS OLD.download_token_rotated_at)
BEGIN SELECT RAISE(ABORT, 'a token change must move link_generation'); END;

DROP TRIGGER passes_auth_token_change_follows_generation;
CREATE TRIGGER passes_auth_token_change_follows_generation BEFORE UPDATE OF auth_token ON passes
WHEN NEW.auth_token IS NOT OLD.auth_token
  AND NOT ((EXISTS (SELECT 1 FROM token_remac_marks m WHERE m.pass_id = OLD.id AND m.kind = 'auth' AND m.mac = NEW.auth_token))
    AND NEW.serial IS OLD.serial AND NEW.credential_generation IS OLD.credential_generation)
  AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = OLD.id AND t.state = 'pending'
    AND t.target_generation = NEW.credential_generation AND t.source_generation < NEW.credential_generation)
BEGIN SELECT RAISE(ABORT, 'an auth_token change must follow a credential generation bump'); END;

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
    OR (OLD.scan_code IS NOT NULL AND NEW.scan_code IS NOT OLD.scan_code))
BEGIN SELECT RAISE(ABORT, 'credential transfer required'); END;

DROP TRIGGER passes_row_version_a;
CREATE TRIGGER passes_row_version_a AFTER UPDATE OF org_id, identity_id, serial, template_id, template_version, auth_token, download_token, web_service_url, personalization, field_sources, display_title, display_subtitle, external_id, holder_email, owner_user_id ON passes
WHEN NEW.row_version = OLD.row_version AND (NEW.org_id IS NOT OLD.org_id OR NEW.identity_id IS NOT OLD.identity_id OR NEW.serial IS NOT OLD.serial OR NEW.template_id IS NOT OLD.template_id OR NEW.template_version IS NOT OLD.template_version OR (NEW.auth_token IS NOT OLD.auth_token AND NOT ((EXISTS (SELECT 1 FROM token_remac_marks m WHERE m.pass_id = OLD.id AND m.kind = 'auth' AND m.mac = NEW.auth_token))
    AND NEW.serial IS OLD.serial AND NEW.credential_generation IS OLD.credential_generation)) OR (NEW.download_token IS NOT OLD.download_token AND NOT ((EXISTS (SELECT 1 FROM token_remac_marks m WHERE m.pass_id = OLD.id AND m.kind = 'download' AND m.mac = NEW.download_token))
    AND NEW.download_token_rotated_at IS OLD.download_token_rotated_at AND NEW.link_generation IS OLD.link_generation)) OR NEW.web_service_url IS NOT OLD.web_service_url OR NEW.personalization IS NOT OLD.personalization OR NEW.field_sources IS NOT OLD.field_sources OR NEW.display_title IS NOT OLD.display_title OR NEW.display_subtitle IS NOT OLD.display_subtitle OR NEW.external_id IS NOT OLD.external_id OR NEW.holder_email IS NOT OLD.holder_email OR NEW.owner_user_id IS NOT OLD.owner_user_id)
BEGIN UPDATE passes SET row_version = row_version + 1 WHERE rowid = NEW.rowid; END;

DROP TRIGGER wallet_provider_pass_authority_changed;
CREATE TRIGGER wallet_provider_pass_authority_changed
AFTER UPDATE OF download_token, owner_user_id, holder_email, link_generation ON passes
WHEN (OLD.download_token IS NOT NEW.download_token AND NOT ((EXISTS (SELECT 1 FROM token_remac_marks m WHERE m.pass_id = OLD.id AND m.kind = 'download' AND m.mac = NEW.download_token))
    AND NEW.download_token_rotated_at IS OLD.download_token_rotated_at AND NEW.link_generation IS OLD.link_generation)) OR OLD.owner_user_id IS NOT NEW.owner_user_id
  OR OLD.holder_email IS NOT NEW.holder_email OR OLD.link_generation IS NOT NEW.link_generation
BEGIN
  INSERT INTO wallet_provider_pass_authority(pass_id, generation) VALUES (NEW.id, 1)
  ON CONFLICT(pass_id) DO UPDATE SET generation = generation + 1;
END;

DROP TRIGGER wallet_provider_dirty_pass;
CREATE TRIGGER wallet_provider_dirty_pass
AFTER UPDATE OF version, revision, lifecycle_generation, status, deleted_at, removed_at, release_id,
  org_id, mode, download_token, owner_user_id, holder_email, link_generation ON passes
WHEN OLD.version IS NOT NEW.version OR OLD.revision IS NOT NEW.revision
  OR OLD.lifecycle_generation IS NOT NEW.lifecycle_generation OR OLD.status IS NOT NEW.status
  OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.removed_at IS NOT NEW.removed_at
  OR OLD.release_id IS NOT NEW.release_id OR OLD.org_id IS NOT NEW.org_id OR OLD.mode IS NOT NEW.mode
  OR (OLD.download_token IS NOT NEW.download_token AND NOT ((EXISTS (SELECT 1 FROM token_remac_marks m WHERE m.pass_id = OLD.id AND m.kind = 'download' AND m.mac = NEW.download_token))
    AND NEW.download_token_rotated_at IS OLD.download_token_rotated_at AND NEW.link_generation IS OLD.link_generation)) OR OLD.owner_user_id IS NOT NEW.owner_user_id
  OR OLD.holder_email IS NOT NEW.holder_email OR OLD.link_generation IS NOT NEW.link_generation
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE pass_id = NEW.id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;

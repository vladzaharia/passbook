-- The Apple web-service token (passes.auth_token) at rest. The column holds a lookup MAC ('h1:' + HMAC under
-- its own derived key, see platform/capability-token.ts); the token is built into pass.json again from a
-- sealed (AES-GCM) copy kept here.
-- Rows written before this migration keep their plain token until the backfill (cron tokens.seal) seals
-- them. The MAC checks here are case-sensitive (GLOB).
CREATE TABLE pass_auth_seals (
  pass_id TEXT PRIMARY KEY REFERENCES passes (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  kek_version INTEGER NOT NULL,
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL
);
-- The backfill's work lists: empty once every token is sealed and every stored pass.json is scrubbed.
CREATE INDEX passes_auth_plain ON passes (id) WHERE auth_token NOT GLOB 'h1:*';
CREATE INDEX pass_versions_auth_plain ON pass_versions (pass_id, version)
  WHERE CASE WHEN json_valid(pass_json) THEN json_type(pass_json, '$.authenticationToken') END IS NOT NULL;

-- The column holds a MAC from now on: nothing writes a plain token, and a change of the token is the finish
-- of a credential transfer, which runs under the generation its start reserved (sealing an old plain token,
-- with serial and generation unchanged, is the one exception).
CREATE TRIGGER passes_auth_token_is_mac_insert BEFORE INSERT ON passes
WHEN NEW.auth_token NOT GLOB 'h1:*'
BEGIN SELECT RAISE(ABORT, 'auth_token must be a MAC'); END;
CREATE TRIGGER passes_auth_token_is_mac_update BEFORE UPDATE OF auth_token ON passes
WHEN NEW.auth_token IS NOT OLD.auth_token AND NEW.auth_token NOT GLOB 'h1:*'
BEGIN SELECT RAISE(ABORT, 'auth_token must be a MAC'); END;
CREATE TRIGGER passes_auth_token_change_follows_generation BEFORE UPDATE OF auth_token ON passes
WHEN NEW.auth_token IS NOT OLD.auth_token
  AND NOT (OLD.auth_token NOT GLOB 'h1:*' AND NEW.auth_token GLOB 'h1:*'
    AND NEW.serial IS OLD.serial AND NEW.credential_generation IS OLD.credential_generation)
  AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = OLD.id AND t.state = 'pending'
    AND t.target_generation = NEW.credential_generation AND t.source_generation < NEW.credential_generation)
BEGIN SELECT RAISE(ABORT, 'an auth_token change must follow a credential generation bump'); END;

-- The stored pass.json of every version never carries the token (it is built in from the sealed copy).
CREATE TRIGGER pass_versions_no_auth_token_insert BEFORE INSERT ON pass_versions
WHEN CASE WHEN json_valid(NEW.pass_json) THEN json_type(NEW.pass_json, '$.authenticationToken') END IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'pass_json must not carry the authenticationToken'); END;
CREATE TRIGGER pass_versions_no_auth_token_update BEFORE UPDATE OF pass_json ON pass_versions
WHEN CASE WHEN json_valid(NEW.pass_json) THEN json_type(NEW.pass_json, '$.authenticationToken') END IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'pass_json must not carry the authenticationToken'); END;

-- Sealing the token is not a credential replacement: the transfer-required guard (0055) lets it through, and
-- passes_row_version_a (0059) does not count it as a pass change.
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
      AND NOT (OLD.auth_token NOT GLOB 'h1:*' AND NEW.auth_token GLOB 'h1:*'
        AND NEW.credential_generation IS OLD.credential_generation))
    OR NEW.identity_id IS NOT OLD.identity_id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
    OR (OLD.scan_code IS NOT NULL AND NEW.scan_code IS NOT OLD.scan_code))
BEGIN SELECT RAISE(ABORT, 'credential transfer required'); END;

DROP TRIGGER passes_row_version_a;
CREATE TRIGGER passes_row_version_a AFTER UPDATE OF org_id, identity_id, serial, template_id, template_version, auth_token, download_token, web_service_url, personalization, field_sources, display_title, display_subtitle, external_id, holder_email, owner_user_id ON passes
WHEN NEW.row_version = OLD.row_version AND (NEW.org_id IS NOT OLD.org_id OR NEW.identity_id IS NOT OLD.identity_id OR NEW.serial IS NOT OLD.serial OR NEW.template_id IS NOT OLD.template_id OR NEW.template_version IS NOT OLD.template_version OR (NEW.auth_token IS NOT OLD.auth_token AND NOT (OLD.auth_token NOT GLOB 'h1:*' AND NEW.auth_token GLOB 'h1:*'
    AND NEW.serial IS OLD.serial AND NEW.credential_generation IS OLD.credential_generation)) OR (NEW.download_token IS NOT OLD.download_token AND NOT (OLD.download_token NOT GLOB 'h1:*' AND NEW.download_token GLOB 'h1:*'
    AND NEW.download_token_rotated_at IS OLD.download_token_rotated_at AND NEW.link_generation IS OLD.link_generation)) OR NEW.web_service_url IS NOT OLD.web_service_url OR NEW.personalization IS NOT OLD.personalization OR NEW.field_sources IS NOT OLD.field_sources OR NEW.display_title IS NOT OLD.display_title OR NEW.display_subtitle IS NOT OLD.display_subtitle OR NEW.external_id IS NOT OLD.external_id OR NEW.holder_email IS NOT OLD.holder_email OR NEW.owner_user_id IS NOT OLD.owner_user_id)
BEGIN UPDATE passes SET row_version = row_version + 1 WHERE rowid = NEW.rowid; END;

-- A deleted pass is never rebuilt: its sealed tokens go with the soft delete (hard delete cascades), and the
-- copies of passes deleted before this migration go now.
CREATE TRIGGER passes_deleted_drops_seals AFTER UPDATE OF deleted_at ON passes
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM pass_auth_seals WHERE pass_id = NEW.id;
  DELETE FROM pass_token_seals WHERE pass_id = NEW.id;
END;
DELETE FROM pass_token_seals WHERE pass_id IN (SELECT id FROM passes WHERE deleted_at IS NOT NULL);

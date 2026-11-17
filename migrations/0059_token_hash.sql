-- Capability tokens at rest. passes.download_token and bundles.token now hold a lookup MAC ('h1:' + HMAC,
-- see platform/capability-token.ts); the link is shown again from a sealed (AES-GCM) copy kept here.
-- Rows written before this migration keep their plain token until the backfill job seals them.
CREATE TABLE pass_token_seals (
  pass_id TEXT PRIMARY KEY REFERENCES passes (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  kek_version INTEGER NOT NULL,
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL
);
CREATE TABLE bundle_token_seals (
  bundle_id TEXT PRIMARY KEY REFERENCES bundles (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  kek_version INTEGER NOT NULL,
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL
);
-- The backfill's work list: empty once every token is sealed.
CREATE INDEX passes_token_plain ON passes (id) WHERE download_token NOT LIKE 'h1:%';
CREATE INDEX bundles_token_plain ON bundles (id) WHERE token NOT LIKE 'h1:%';

-- A token column holds a MAC from now on: nothing may write a plain token, and a change of the pass token
-- is a rotation, which moves link_generation (the sealing of an old plain token is the one exception).
CREATE TRIGGER passes_token_is_mac_insert BEFORE INSERT ON passes
WHEN NEW.download_token NOT LIKE 'h1:%'
BEGIN SELECT RAISE(ABORT, 'download_token must be a MAC'); END;
CREATE TRIGGER passes_token_is_mac_update BEFORE UPDATE OF download_token ON passes
WHEN NEW.download_token IS NOT OLD.download_token AND NEW.download_token NOT LIKE 'h1:%'
BEGIN SELECT RAISE(ABORT, 'download_token must be a MAC'); END;
CREATE TRIGGER passes_token_change_moves_link BEFORE UPDATE OF download_token ON passes
WHEN NEW.download_token IS NOT OLD.download_token AND NEW.link_generation IS OLD.link_generation
  AND NOT (OLD.download_token NOT LIKE 'h1:%' AND NEW.download_token LIKE 'h1:%'
    AND NEW.download_token_rotated_at IS OLD.download_token_rotated_at)
BEGIN SELECT RAISE(ABORT, 'a token change must move link_generation'); END;
CREATE TRIGGER bundles_token_is_mac_insert BEFORE INSERT ON bundles
WHEN NEW.token NOT LIKE 'h1:%'
BEGIN SELECT RAISE(ABORT, 'token must be a MAC'); END;
CREATE TRIGGER bundles_token_is_mac_update BEFORE UPDATE OF token ON bundles
WHEN NEW.token IS NOT OLD.token AND NEW.token NOT LIKE 'h1:%'
BEGIN SELECT RAISE(ABORT, 'token must be a MAC'); END;

-- Sealing a token (plain -> MAC, same rotation timestamp and link generation) is not a pass change: it
-- bumps neither row_version nor the wallet-provider authority and dirty counters. A rotation still does.

DROP TRIGGER wallet_provider_pass_authority_changed;
CREATE TRIGGER wallet_provider_pass_authority_changed
AFTER UPDATE OF download_token, owner_user_id, holder_email, link_generation ON passes
WHEN (OLD.download_token IS NOT NEW.download_token AND NOT (OLD.download_token NOT LIKE 'h1:%' AND NEW.download_token LIKE 'h1:%'
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
  OR (OLD.download_token IS NOT NEW.download_token AND NOT (OLD.download_token NOT LIKE 'h1:%' AND NEW.download_token LIKE 'h1:%'
    AND NEW.download_token_rotated_at IS OLD.download_token_rotated_at AND NEW.link_generation IS OLD.link_generation)) OR OLD.owner_user_id IS NOT NEW.owner_user_id
  OR OLD.holder_email IS NOT NEW.holder_email OR OLD.link_generation IS NOT NEW.link_generation
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE pass_id = NEW.id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;

DROP TRIGGER passes_row_version_a;
CREATE TRIGGER passes_row_version_a AFTER UPDATE OF org_id, identity_id, serial, template_id, template_version, auth_token, download_token, web_service_url, personalization, field_sources, display_title, display_subtitle, external_id, holder_email, owner_user_id ON passes
WHEN NEW.row_version = OLD.row_version AND (NEW.org_id IS NOT OLD.org_id OR NEW.identity_id IS NOT OLD.identity_id OR NEW.serial IS NOT OLD.serial OR NEW.template_id IS NOT OLD.template_id OR NEW.template_version IS NOT OLD.template_version OR NEW.auth_token IS NOT OLD.auth_token OR (NEW.download_token IS NOT OLD.download_token AND NOT (OLD.download_token NOT LIKE 'h1:%' AND NEW.download_token LIKE 'h1:%'
    AND NEW.download_token_rotated_at IS OLD.download_token_rotated_at AND NEW.link_generation IS OLD.link_generation)) OR NEW.web_service_url IS NOT OLD.web_service_url OR NEW.personalization IS NOT OLD.personalization OR NEW.field_sources IS NOT OLD.field_sources OR NEW.display_title IS NOT OLD.display_title OR NEW.display_subtitle IS NOT OLD.display_subtitle OR NEW.external_id IS NOT OLD.external_id OR NEW.holder_email IS NOT OLD.holder_email OR NEW.owner_user_id IS NOT OLD.owner_user_id)
BEGIN UPDATE passes SET row_version = row_version + 1 WHERE rowid = NEW.rowid; END;

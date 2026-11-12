-- Authority epochs and grant rows (docs/design/authority-epochs.md). Epochs are owned by triggers:
-- they start at 1, only increase, and app code never writes them. A statement may move one more than once.

-- orgs.config_revision: profile and org settings (the CAS for edits). access_revision lives in 0029.
ALTER TABLE orgs ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER orgs_config_revision AFTER UPDATE OF name, slug, branding, default_identity_id ON orgs
WHEN NEW.config_revision = OLD.config_revision AND (NEW.name IS NOT OLD.name OR NEW.slug IS NOT OLD.slug OR NEW.branding IS NOT OLD.branding OR NEW.default_identity_id IS NOT OLD.default_identity_id)
BEGIN UPDATE orgs SET config_revision = config_revision + 1 WHERE rowid = NEW.rowid; END;
CREATE TRIGGER orgs_config_revision_monotonic BEFORE UPDATE OF config_revision ON orgs
WHEN NEW.config_revision < OLD.config_revision
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;
-- users.access_revision moves only with status: deferred work captures it, so disabling and re-enabling a
-- user cannot revive what was queued before.
ALTER TABLE users ADD COLUMN access_revision INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER users_access_revision AFTER UPDATE OF status ON users
WHEN NEW.status IS NOT OLD.status AND NEW.access_revision = OLD.access_revision
BEGIN UPDATE users SET access_revision = access_revision + 1 WHERE rowid = NEW.rowid; END;
CREATE TRIGGER users_access_revision_monotonic BEFORE UPDATE OF access_revision ON users
WHEN NEW.access_revision < OLD.access_revision
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;
CREATE TRIGGER orgs_fixed_columns BEFORE UPDATE OF id, created_at ON orgs
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'orgs identity is immutable'); END;
CREATE TRIGGER orgs_no_replace BEFORE INSERT ON orgs
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM orgs WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: orgs.id') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM orgs WHERE slug = NEW.slug)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: orgs.slug') END;
END;
CREATE TRIGGER settings_org_config_insert AFTER INSERT ON settings WHEN NEW.scope GLOB 'org:*'
BEGIN UPDATE orgs SET config_revision = config_revision + 1 WHERE id = substr(NEW.scope, 5); END;
-- A row moved to another scope or key changes both orgs' settings.
CREATE TRIGGER settings_org_config_update AFTER UPDATE OF value, scope, key ON settings
WHEN (NEW.scope GLOB 'org:*' OR OLD.scope GLOB 'org:*')
  AND (NEW.value IS NOT OLD.value OR NEW.scope IS NOT OLD.scope OR NEW.key IS NOT OLD.key)
BEGIN UPDATE orgs SET config_revision = config_revision + 1
  WHERE id IN (CASE WHEN NEW.scope GLOB 'org:*' THEN substr(NEW.scope, 5) END,
               CASE WHEN OLD.scope GLOB 'org:*' THEN substr(OLD.scope, 5) END); END;
CREATE TRIGGER settings_org_config_delete AFTER DELETE ON settings WHEN OLD.scope GLOB 'org:*'
BEGIN UPDATE orgs SET config_revision = config_revision + 1 WHERE id = substr(OLD.scope, 5); END;

-- passes.row_version: staleness for writes derived from a read. The bump set is split in three to bound
-- expression depth (D1 allows 100). scan_code, barcode_hash and lookup_hash bump only once set.
ALTER TABLE passes ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER passes_row_version_a AFTER UPDATE OF org_id, identity_id, serial, template_id, template_version, auth_token, download_token, web_service_url, personalization, field_sources, display_title, display_subtitle, external_id, holder_email, owner_user_id ON passes
WHEN NEW.row_version = OLD.row_version AND (NEW.org_id IS NOT OLD.org_id OR NEW.identity_id IS NOT OLD.identity_id OR NEW.serial IS NOT OLD.serial OR NEW.template_id IS NOT OLD.template_id OR NEW.template_version IS NOT OLD.template_version OR NEW.auth_token IS NOT OLD.auth_token OR NEW.download_token IS NOT OLD.download_token OR NEW.web_service_url IS NOT OLD.web_service_url OR NEW.personalization IS NOT OLD.personalization OR NEW.field_sources IS NOT OLD.field_sources OR NEW.display_title IS NOT OLD.display_title OR NEW.display_subtitle IS NOT OLD.display_subtitle OR NEW.external_id IS NOT OLD.external_id OR NEW.holder_email IS NOT OLD.holder_email OR NEW.owner_user_id IS NOT OLD.owner_user_id)
BEGIN UPDATE passes SET row_version = row_version + 1 WHERE rowid = NEW.rowid; END;
CREATE TRIGGER passes_row_version_b AFTER UPDATE OF status, version, revision, object_key, deleted_at, modified_at, connection_id, external_ref, link_generation, mode, barcode_hash, scan_code, removed_at, lookup_hash, removal_message ON passes
WHEN NEW.row_version = OLD.row_version AND (NEW.status IS NOT OLD.status OR NEW.version IS NOT OLD.version OR NEW.revision IS NOT OLD.revision OR NEW.object_key IS NOT OLD.object_key OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.modified_at IS NOT OLD.modified_at OR NEW.connection_id IS NOT OLD.connection_id OR NEW.external_ref IS NOT OLD.external_ref OR NEW.link_generation IS NOT OLD.link_generation OR NEW.mode IS NOT OLD.mode OR (OLD.barcode_hash IS NOT NULL AND NEW.barcode_hash IS NOT OLD.barcode_hash) OR (OLD.scan_code IS NOT NULL AND NEW.scan_code IS NOT OLD.scan_code) OR NEW.removed_at IS NOT OLD.removed_at OR (OLD.lookup_hash IS NOT NULL AND NEW.lookup_hash IS NOT OLD.lookup_hash) OR NEW.removal_message IS NOT OLD.removal_message)
BEGIN UPDATE passes SET row_version = row_version + 1 WHERE rowid = NEW.rowid; END;
CREATE TRIGGER passes_row_version_c AFTER UPDATE OF removal_prior_status, test_data_quarantined, lifecycle_generation, removal_published_generation, removal_claim_version, removal_claim_status, removal_claim_object_key, removal_claim_link_generation, release_id, credential_generation, image_generation ON passes
WHEN NEW.row_version = OLD.row_version AND (NEW.removal_prior_status IS NOT OLD.removal_prior_status OR NEW.test_data_quarantined IS NOT OLD.test_data_quarantined OR NEW.lifecycle_generation IS NOT OLD.lifecycle_generation OR NEW.removal_published_generation IS NOT OLD.removal_published_generation OR NEW.removal_claim_version IS NOT OLD.removal_claim_version OR NEW.removal_claim_status IS NOT OLD.removal_claim_status OR NEW.removal_claim_object_key IS NOT OLD.removal_claim_object_key OR NEW.removal_claim_link_generation IS NOT OLD.removal_claim_link_generation OR NEW.release_id IS NOT OLD.release_id OR NEW.credential_generation IS NOT OLD.credential_generation OR NEW.image_generation IS NOT OLD.image_generation)
BEGIN UPDATE passes SET row_version = row_version + 1 WHERE rowid = NEW.rowid; END;
CREATE TRIGGER passes_row_version_monotonic BEFORE UPDATE OF row_version ON passes
WHEN NEW.row_version < OLD.row_version
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;
CREATE TRIGGER passes_fixed_columns BEFORE UPDATE OF id, created_at, created_by ON passes
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR (NEW.created_by IS NOT OLD.created_by AND NOT (OLD.created_by IS NOT NULL AND NEW.created_by IS NULL
    AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.created_by)))
BEGIN SELECT RAISE(ABORT, 'passes identity is immutable'); END;

ALTER TABLE scanners ADD COLUMN credential_epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE scanners ADD COLUMN config_epoch INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER scanners_credential_epoch AFTER UPDATE OF token_hash, token_prefix, csrf_secret, revoked_at, expires_at, org_id, mode, kind, pair_code_hash, paired_at ON scanners
WHEN NEW.credential_epoch = OLD.credential_epoch AND (NEW.token_hash IS NOT OLD.token_hash OR NEW.token_prefix IS NOT OLD.token_prefix OR NEW.csrf_secret IS NOT OLD.csrf_secret OR NEW.revoked_at IS NOT OLD.revoked_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode OR NEW.kind IS NOT OLD.kind OR NEW.pair_code_hash IS NOT OLD.pair_code_hash OR NEW.paired_at IS NOT OLD.paired_at)
BEGIN UPDATE scanners SET credential_epoch = credential_epoch + 1 WHERE rowid = NEW.rowid; END;
CREATE TRIGGER scanners_config_epoch AFTER UPDATE OF device_role, event_id, settings, time_zone ON scanners
WHEN NEW.config_epoch = OLD.config_epoch AND (NEW.device_role IS NOT OLD.device_role OR NEW.event_id IS NOT OLD.event_id OR NEW.settings IS NOT OLD.settings OR NEW.time_zone IS NOT OLD.time_zone)
BEGIN UPDATE scanners SET config_epoch = config_epoch + 1 WHERE rowid = NEW.rowid; END;
CREATE TRIGGER scanners_credential_epoch_monotonic BEFORE UPDATE OF credential_epoch ON scanners
WHEN NEW.credential_epoch < OLD.credential_epoch
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;
CREATE TRIGGER scanners_config_epoch_monotonic BEFORE UPDATE OF config_epoch ON scanners
WHEN NEW.config_epoch < OLD.config_epoch
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;
CREATE TRIGGER scanners_fixed_columns BEFORE UPDATE OF created_at, created_by ON scanners
WHEN NEW.created_at IS NOT OLD.created_at OR (NEW.created_by IS NOT OLD.created_by AND NOT (OLD.created_by IS NOT NULL AND NEW.created_by IS NULL
    AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.created_by)))
BEGIN SELECT RAISE(ABORT, 'scanners identity is immutable'); END;
CREATE TRIGGER scanning_devices_config_insert AFTER INSERT ON scanning_devices
BEGIN UPDATE scanners SET config_epoch = config_epoch + 1 WHERE id = NEW.scanner_id; END;
CREATE TRIGGER scanning_devices_config_update AFTER UPDATE OF scanner_id, session_id, org_id, mode, surface, effective_surface, overrides, admin_user_id, device_key ON scanning_devices
WHEN NEW.scanner_id IS NOT OLD.scanner_id OR NEW.session_id IS NOT OLD.session_id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode OR NEW.surface IS NOT OLD.surface OR NEW.effective_surface IS NOT OLD.effective_surface OR NEW.overrides IS NOT OLD.overrides OR NEW.admin_user_id IS NOT OLD.admin_user_id OR NEW.device_key IS NOT OLD.device_key
BEGIN UPDATE scanners SET config_epoch = config_epoch + 1 WHERE id IN (NEW.scanner_id, OLD.scanner_id); END;
CREATE TRIGGER scanning_devices_no_replace BEFORE INSERT ON scanning_devices
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM scanning_devices WHERE scanner_id = NEW.scanner_id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanning_devices.scanner_id') END;
  -- The partial unique index scanning_devices_admin (0024): a REPLACE would drop the other scanner's row.
  SELECT CASE WHEN NEW.admin_user_id IS NOT NULL AND NEW.device_key IS NOT NULL AND EXISTS (
      SELECT 1 FROM scanning_devices WHERE session_id = NEW.session_id
        AND admin_user_id = NEW.admin_user_id AND device_key = NEW.device_key)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanning_devices.session_id, scanning_devices.admin_user_id, scanning_devices.device_key') END;
END;
CREATE TRIGGER scanning_devices_config_delete AFTER DELETE ON scanning_devices
BEGIN UPDATE scanners SET config_epoch = config_epoch + 1 WHERE id = OLD.scanner_id; END;
CREATE TRIGGER scanner_templates_config_insert AFTER INSERT ON scanner_templates
BEGIN UPDATE scanners SET config_epoch = config_epoch + 1 WHERE id = NEW.scanner_id; END;
CREATE TRIGGER scanner_templates_config_update AFTER UPDATE OF scanner_id, template_id ON scanner_templates
WHEN NEW.scanner_id IS NOT OLD.scanner_id OR NEW.template_id IS NOT OLD.template_id
BEGIN UPDATE scanners SET config_epoch = config_epoch + 1 WHERE id IN (NEW.scanner_id, OLD.scanner_id); END;
CREATE TRIGGER scanner_templates_config_delete AFTER DELETE ON scanner_templates
BEGIN UPDATE scanners SET config_epoch = config_epoch + 1 WHERE id = OLD.scanner_id; END;

ALTER TABLE scan_staff ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER scan_staff_auth_epoch AFTER UPDATE OF role, pin_hash, pin_set_at, disabled_at, org_id ON scan_staff
WHEN NEW.auth_epoch = OLD.auth_epoch AND (NEW.role IS NOT OLD.role OR NEW.pin_hash IS NOT OLD.pin_hash OR NEW.pin_set_at IS NOT OLD.pin_set_at OR NEW.disabled_at IS NOT OLD.disabled_at OR NEW.org_id IS NOT OLD.org_id)
BEGIN UPDATE scan_staff SET auth_epoch = auth_epoch + 1 WHERE rowid = NEW.rowid; END;
CREATE TRIGGER scan_staff_auth_epoch_monotonic BEFORE UPDATE OF auth_epoch ON scan_staff
WHEN NEW.auth_epoch < OLD.auth_epoch
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;
CREATE TRIGGER scan_staff_fixed_columns BEFORE UPDATE OF id, created_at, created_by ON scan_staff
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR (NEW.created_by IS NOT OLD.created_by AND NOT (OLD.created_by IS NOT NULL AND NEW.created_by IS NULL
    AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.created_by)))
BEGIN SELECT RAISE(ABORT, 'scan_staff identity is immutable'); END;
CREATE TRIGGER scan_staff_no_replace BEFORE INSERT ON scan_staff
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM scan_staff WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scan_staff.id') END;
END;
CREATE TRIGGER scan_staff_no_replace_name BEFORE INSERT ON scan_staff
WHEN NEW.disabled_at IS NULL AND EXISTS (SELECT 1 FROM scan_staff
  WHERE org_id = NEW.org_id AND name = NEW.name COLLATE NOCASE AND disabled_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: scan_staff.org_id, scan_staff.name'); END;

ALTER TABLE scan_events ADD COLUMN config_epoch INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER scan_events_config_epoch AFTER UPDATE OF match_input, match_values, opens_at, closes_at, time_zone, capacity, reentry, archived_at, org_id, mode ON scan_events
WHEN NEW.config_epoch = OLD.config_epoch AND (NEW.match_input IS NOT OLD.match_input OR NEW.match_values IS NOT OLD.match_values OR NEW.opens_at IS NOT OLD.opens_at OR NEW.closes_at IS NOT OLD.closes_at OR NEW.time_zone IS NOT OLD.time_zone OR NEW.capacity IS NOT OLD.capacity OR NEW.reentry IS NOT OLD.reentry OR NEW.archived_at IS NOT OLD.archived_at OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode)
BEGIN UPDATE scan_events SET config_epoch = config_epoch + 1 WHERE rowid = NEW.rowid; END;
CREATE TRIGGER scan_events_config_epoch_monotonic BEFORE UPDATE OF config_epoch ON scan_events
WHEN NEW.config_epoch < OLD.config_epoch
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;
CREATE TRIGGER scan_events_fixed_columns BEFORE UPDATE OF id, created_at, created_by ON scan_events
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR (NEW.created_by IS NOT OLD.created_by AND NOT (OLD.created_by IS NOT NULL AND NEW.created_by IS NULL
    AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.created_by)))
BEGIN SELECT RAISE(ABORT, 'scan_events identity is immutable'); END;
CREATE TRIGGER scan_events_no_replace BEFORE INSERT ON scan_events
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM scan_events WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scan_events.id') END;
END;
CREATE TRIGGER scan_event_templates_config_insert AFTER INSERT ON scan_event_templates
BEGIN UPDATE scan_events SET config_epoch = config_epoch + 1 WHERE id = NEW.event_id; END;
CREATE TRIGGER scan_event_templates_config_update AFTER UPDATE OF event_id, template_id ON scan_event_templates
WHEN NEW.event_id IS NOT OLD.event_id OR NEW.template_id IS NOT OLD.template_id
BEGIN UPDATE scan_events SET config_epoch = config_epoch + 1 WHERE id IN (NEW.event_id, OLD.event_id); END;
CREATE TRIGGER scan_event_templates_config_delete AFTER DELETE ON scan_event_templates
BEGIN UPDATE scan_events SET config_epoch = config_epoch + 1 WHERE id = OLD.event_id; END;

ALTER TABLE scanning_sessions ADD COLUMN config_epoch INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER scanning_sessions_config_epoch AFTER UPDATE OF status, accepts, settings, time_zone, org_id, mode ON scanning_sessions
WHEN NEW.config_epoch = OLD.config_epoch AND (NEW.status IS NOT OLD.status OR NEW.accepts IS NOT OLD.accepts OR NEW.settings IS NOT OLD.settings OR NEW.time_zone IS NOT OLD.time_zone OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode)
BEGIN UPDATE scanning_sessions SET config_epoch = config_epoch + 1 WHERE rowid = NEW.rowid; END;
CREATE TRIGGER scanning_sessions_config_epoch_monotonic BEFORE UPDATE OF config_epoch ON scanning_sessions
WHEN NEW.config_epoch < OLD.config_epoch
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;
CREATE TRIGGER scanning_sessions_fixed_columns BEFORE UPDATE OF id, created_at, created_by ON scanning_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR (NEW.created_by IS NOT OLD.created_by AND NOT (OLD.created_by IS NOT NULL AND NEW.created_by IS NULL
    AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.created_by)))
BEGIN SELECT RAISE(ABORT, 'scanning_sessions identity is immutable'); END;
CREATE TRIGGER scanning_sessions_no_replace BEFORE INSERT ON scanning_sessions
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM scanning_sessions WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanning_sessions.id') END;
END;

-- connections.generation (W3-01's authority_epoch) keeps its app-owned bumps in WP0: tests simulate a
-- concurrent edit with a raw UPDATE that must not move it, and WP4 owns the connection fences. WP4 adds the
-- bump trigger (docs/design/authority-epochs.md, "WP0 spike results"); only the guards live here.
CREATE TRIGGER connections_generation_monotonic BEFORE UPDATE OF generation ON connections
WHEN NEW.generation < OLD.generation
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;
CREATE TRIGGER connections_fixed_columns BEFORE UPDATE OF id, created_at ON connections
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'connections identity is immutable'); END;
CREATE TRIGGER connections_no_replace BEFORE INSERT ON connections
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM connections WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: connections.id') END;
END;

-- Release heads: the newest release per (template, org scope, mode, provider). org_scope is '' for the
-- platform scope. A view, not a table: a trigger-maintained table inflates the meta.changes of every
-- release insert (D1 counts trigger changes), and a view cannot be written, replaced or drifted.
CREATE VIEW template_release_heads AS
SELECT r.template_id AS template_id, COALESCE(r.org_id, '') AS org_scope, r.mode AS mode,
  r.provider AS provider, r.id AS release_id, r.generation AS generation
FROM template_releases r
WHERE r.generation = (SELECT MAX(n.generation) FROM template_releases n
  WHERE n.template_id = r.template_id AND n.org_id IS r.org_id AND n.mode = r.mode AND n.provider = r.provider);

-- Head lookups (releaseHead) read the newest generation per (template, mode, provider, org): the unique
-- indexes above are partial by org, so this one serves both scopes.
CREATE INDEX template_releases_head ON template_releases(template_id, mode, provider, org_id, generation);

-- Per-version content hash and per-asset sha256 (W1-09), written once at candidate creation and baked sync.
-- template_versions is immutable, so the hashes live beside it. Issuance compares content_hash with the release
-- in SQL instead of re-reading asset bytes. A row that differs from the release makes it ineffective; a version
-- with no row has never been hashed, so its first issuance verifies the bytes and saves the row (legacy
-- releases are exempt). asset_hashes is a JSON array aligned with template_versions.assets: [{name, sha256}].
CREATE TABLE template_version_hashes (
  template_id TEXT NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  asset_hashes TEXT NOT NULL CHECK (json_valid(asset_hashes) AND json_type(asset_hashes) = 'array'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, version),
  FOREIGN KEY (template_id, version) REFERENCES template_versions(template_id, version)
);
CREATE TRIGGER template_version_hashes_immutable BEFORE UPDATE ON template_version_hashes
BEGIN SELECT RAISE(ABORT, 'template version hashes are immutable'); END;
CREATE TRIGGER template_version_hashes_no_delete BEFORE DELETE ON template_version_hashes
BEGIN SELECT RAISE(ABORT, 'template version hashes are immutable'); END;
CREATE TRIGGER template_version_hashes_no_replace BEFORE INSERT ON template_version_hashes
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM template_version_hashes
      WHERE template_id = NEW.template_id AND version = NEW.version)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: template_version_hashes.version') END;
END;

-- A deleted API key's id is never issued again.
CREATE TABLE retired_api_key_ids (id TEXT PRIMARY KEY);
CREATE TRIGGER api_keys_retire_id AFTER DELETE ON api_keys
BEGIN INSERT OR IGNORE INTO retired_api_key_ids (id) VALUES (OLD.id); END;
CREATE TRIGGER api_keys_no_id_reuse BEFORE INSERT ON api_keys
WHEN EXISTS (SELECT 1 FROM retired_api_key_ids WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: api_keys.id'); END;

CREATE TRIGGER retired_api_key_ids_no_update BEFORE UPDATE ON retired_api_key_ids
BEGIN SELECT RAISE(ABORT, 'retired API key ID is immutable'); END;
CREATE TRIGGER retired_api_key_ids_no_delete BEFORE DELETE ON retired_api_key_ids
BEGIN SELECT RAISE(ABORT, 'retired API key ID is immutable'); END;

-- Revocation stops queued work (owner answers 2, 3 and 9). A scheduled broadcast is cancelled by the
-- same statement that disables its creator, suspends or deletes its org, or revokes the creator's
-- membership, on every path. Cancelled work stays cancelled: nothing moves a broadcast back to scheduled.
CREATE TRIGGER users_disable_cancels_broadcasts AFTER UPDATE OF status ON users
WHEN NEW.status = 'disabled' AND OLD.status IS NOT 'disabled'
BEGIN
  UPDATE broadcasts SET state = 'cancelled', error_code = 'CREATOR_REVOKED',
    finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE created_by_type = 'user' AND created_by_id = NEW.id AND state = 'scheduled';
END;
CREATE TRIGGER orgs_inactive_cancels_broadcasts AFTER UPDATE OF status ON orgs
WHEN NEW.status IN ('suspended', 'deleted') AND OLD.status IS NOT NEW.status
BEGIN
  UPDATE broadcasts SET state = 'cancelled', error_code = 'ORG_INACTIVE',
    finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE org_id = NEW.id AND state = 'scheduled';
END;
CREATE TRIGGER memberships_revoke_cancels_broadcasts AFTER UPDATE OF revoked_at ON org_memberships
WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
BEGIN
  UPDATE broadcasts SET state = 'cancelled', error_code = 'CREATOR_REVOKED',
    finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE created_by_type = 'user' AND created_by_id = NEW.user_id AND org_id = NEW.org_id
    AND state = 'scheduled';
END;

-- One grant row per write batch (section 1.2). grant() inserts it first and deletes it last in the same
-- D1 batch; a failed check aborts the insert, which rolls back the batch. leak_guard is a deferred foreign
-- key to a table that is always empty, so a batch that commits with its grant still present fails.
CREATE TABLE authority_grant_leaks (id TEXT PRIMARY KEY);
CREATE TRIGGER authority_grant_leaks_never BEFORE INSERT ON authority_grant_leaks
BEGIN SELECT RAISE(ABORT, 'authority_grant_leaks is always empty'); END;
CREATE TABLE authority_grants (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('org', 'org_mode', 'platform')),
  org_id TEXT,
  mode TEXT,
  principal TEXT NOT NULL,
  purpose TEXT NOT NULL,
  target_id TEXT,
  denied TEXT,
  created_at INTEGER NOT NULL,
  leak_guard TEXT NOT NULL REFERENCES authority_grant_leaks(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((scope = 'platform' AND org_id IS NULL AND mode IS NULL)
      OR (scope = 'org' AND org_id IS NOT NULL AND mode IS NULL)
      OR (scope = 'org_mode' AND org_id IS NOT NULL AND mode IN ('live', 'test'))),
  CHECK (purpose GLOB scope || '.*'),
  CHECK (leak_guard = id),
  CHECK (purpose NOT GLOB '*.connection.*' OR IFNULL(mode, '') = 'live'),
  CHECK (principal NOT GLOB 'system:*' OR purpose GLOB '*.job.*'),
  CHECK (principal NOT GLOB 'holder:*' OR purpose IN ('org_mode.pass.holder_remove', 'org_mode.pass.holder_attach')),
  CHECK (principal NOT GLOB 'device:*' OR purpose = 'org_mode.pass.personalize'),
  CHECK (principal GLOB 'holder:*' OR principal GLOB 'device:*'
    OR purpose NOT IN ('org_mode.pass.holder_remove', 'org_mode.pass.holder_attach', 'org_mode.pass.personalize'))
);
CREATE INDEX authority_grants_leak_guard ON authority_grants(leak_guard);
CREATE TRIGGER authority_grants_deny BEFORE INSERT ON authority_grants WHEN NEW.denied IS NOT NULL
BEGIN SELECT CASE NEW.denied
  WHEN 'org' THEN RAISE(ABORT, 'authority_denied:org') WHEN 'actor' THEN RAISE(ABORT, 'authority_denied:actor')
  WHEN 'staff' THEN RAISE(ABORT, 'authority_denied:staff')
  WHEN 'config' THEN RAISE(ABORT, 'authority_denied:config') WHEN 'lineage' THEN RAISE(ABORT, 'authority_denied:lineage')
  WHEN 'stale' THEN RAISE(ABORT, 'authority_denied:stale') WHEN 'release' THEN RAISE(ABORT, 'authority_denied:release')
  WHEN 'retention' THEN RAISE(ABORT, 'authority_denied:retention') ELSE RAISE(ABORT, 'authority_denied:other') END; END;
CREATE TRIGGER authority_grants_immutable BEFORE UPDATE ON authority_grants
BEGIN SELECT RAISE(ABORT, 'authority grant is immutable'); END;


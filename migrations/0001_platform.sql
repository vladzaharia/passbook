-- Platform schema. IDs are TEXT (UUIDv7/ULID), timestamps INTEGER ms, emails normalized
-- (trim, lower-case, NFC). Every FK child column is indexed.
-- Owner after foundation: the integration agent. Module agents add migrations/00NN_<module>.sql.

-- Tenancy and identity

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 2 AND 64),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  default_identity_id TEXT REFERENCES signing_identities (id) ON DELETE SET NULL,
  branding TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(branding)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX orgs_default_identity ON orgs (default_identity_id);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  primary_email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  last_roles TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(last_roles))
);

CREATE TABLE user_emails (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  verified_via TEXT NOT NULL CHECK (verified_via IN ('magic_link', 'oidc', 'admin')),
  verified_at INTEGER NOT NULL
);
CREATE INDEX user_emails_user ON user_emails (user_id);

CREATE TABLE auth_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email_claim TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  groups TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(groups)),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX auth_identities_user ON auth_identities (user_id);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amr TEXT NOT NULL CHECK (amr IN ('oidc', 'magic_link')),
  roles TEXT NOT NULL DEFAULT '["user"]' CHECK (json_valid(roles)),
  csrf_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  ip_prefix TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'sign_in' CHECK (purpose IN ('sign_in', 'verify_email')),
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT,
  browser_binding_hash TEXT,
  redirect_path TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX magic_links_email ON magic_links (email, created_at);
CREATE INDEX magic_links_expiry ON magic_links (expires_at);
CREATE INDEX magic_links_user ON magic_links (user_id);

CREATE TABLE oidc_flows (
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_path TEXT,
  browser_binding_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oidc_flows_expiry ON oidc_flows (expires_at);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_keys_org ON api_keys (org_id);
CREATE INDEX api_keys_created_by ON api_keys (created_by);

-- Secrets (envelope-encrypted; AAD = id|org_id|kind)

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pass_signer', 'connector', 'webhook')),
  kek_version INTEGER NOT NULL,
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  fingerprint TEXT,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);
CREATE INDEX credentials_org ON credentials (org_id);
CREATE INDEX credentials_created_by ON credentials (created_by);

CREATE TABLE signing_identities (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs (id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  pass_type_identifier TEXT NOT NULL UNIQUE,
  team_identifier TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('env', 'db')),
  env_prefix TEXT,
  credential_id TEXT REFERENCES credentials (id),
  cert_pem TEXT,
  cert_sha256 TEXT,
  not_before INTEGER,
  not_after INTEGER,
  apns_binding TEXT,
  apns_health TEXT NOT NULL DEFAULT 'unknown' CHECK (apns_health IN ('unknown', 'healthy', 'failing')),
  nfc_enabled INTEGER NOT NULL DEFAULT 0 CHECK (nfc_enabled IN (0, 1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at INTEGER NOT NULL,
  CHECK ((source = 'env' AND env_prefix IS NOT NULL) OR (source = 'db' AND credential_id IS NOT NULL))
);
CREATE INDEX signing_identities_org ON signing_identities (org_id);
CREATE INDEX signing_identities_credential ON signing_identities (credential_id);
CREATE UNIQUE INDEX signing_identities_one_default ON signing_identities (is_default) WHERE is_default = 1;

-- Templates

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs (id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('baked', 'uploaded')),
  active_version TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  styles TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(styles)),
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (org_id, slug)
);
CREATE INDEX templates_created_by ON templates (created_by);

CREATE TABLE template_versions (
  template_id TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  pass_json TEXT NOT NULL CHECK (json_valid(pass_json)),
  assets TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(assets)),
  report TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(report)),
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, version)
);
CREATE INDEX template_versions_created_by ON template_versions (created_by);

CREATE TRIGGER template_versions_immutable
BEFORE UPDATE ON template_versions
BEGIN
  SELECT RAISE(ABORT, 'template versions are immutable');
END;

-- Connections

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL,
  connector_version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  credential_id TEXT REFERENCES credentials (id) ON DELETE SET NULL,
  webhook_credential_id TEXT REFERENCES credentials (id) ON DELETE SET NULL,
  mapping TEXT CHECK (mapping IS NULL OR json_valid(mapping)),
  default_template_id TEXT REFERENCES templates (id) ON DELETE SET NULL,
  holder_email_field TEXT,
  auto_create INTEGER NOT NULL DEFAULT 0 CHECK (auto_create IN (0, 1)),
  auto_email INTEGER NOT NULL DEFAULT 0 CHECK (auto_email IN (0, 1)),
  on_missing TEXT NOT NULL DEFAULT 'flag' CHECK (on_missing IN ('keep', 'flag', 'void')),
  mode TEXT NOT NULL DEFAULT 'poll' CHECK (mode IN ('poll', 'webhook', 'hybrid', 'manual', 'snapshot')),
  interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds >= 60),
  max_concurrency INTEGER CHECK (max_concurrency IS NULL OR max_concurrency BETWEEN 1 AND 20),
  requests_per_minute INTEGER CHECK (requests_per_minute IS NULL OR requests_per_minute BETWEEN 1 AND 6000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  generation INTEGER NOT NULL DEFAULT 1,
  health TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health IN ('unknown', 'healthy', 'degraded', 'failing', 'paused', 'disabled')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  breaker_open_until INTEGER,
  cursor TEXT,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_success_at INTEGER,
  last_error_code TEXT,
  last_error_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX connections_org ON connections (org_id);
CREATE INDEX connections_credential ON connections (credential_id);
CREATE INDEX connections_webhook_credential ON connections (webhook_credential_id);
CREATE INDEX connections_default_template ON connections (default_template_id);
CREATE INDEX connections_due ON connections (next_run_at) WHERE enabled = 1;

CREATE TABLE connection_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'webhook', 'admin', 'user', 'test', 'backfill')),
  actor_id TEXT,
  pass_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'running'
    CHECK (outcome IN ('running', 'unchanged', 'changed', 'error', 'skipped')),
  records_seen INTEGER,
  passes_changed INTEGER,
  error_code TEXT,
  error_detail TEXT,
  http_status INTEGER,
  duration_ms INTEGER
);
CREATE INDEX connection_runs_recent ON connection_runs (connection_id, started_at DESC);
CREATE INDEX connection_runs_pass ON connection_runs (pass_id, started_at DESC);

CREATE TABLE webhook_events (
  connection_id TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, event_id)
);
CREATE INDEX webhook_events_received ON webhook_events (received_at);

-- Passes

CREATE TABLE passes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  identity_id TEXT NOT NULL REFERENCES signing_identities (id),
  serial TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  auth_token TEXT NOT NULL,
  download_token TEXT NOT NULL UNIQUE,
  download_token_rotated_at INTEGER,
  web_service_url TEXT NOT NULL,
  personalization TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(personalization)),
  field_sources TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(field_sources)),
  display_title TEXT,
  display_subtitle TEXT,
  external_id TEXT,
  -- One holder per pass. State: unassigned (no email, no owner), waiting (email, no owner), owned.
  holder_email TEXT,
  owner_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  object_key TEXT NOT NULL,
  object_sha256 TEXT,
  object_size INTEGER,
  modified_at INTEGER NOT NULL,
  modified_collision INTEGER NOT NULL DEFAULT 0,
  connection_id TEXT REFERENCES connections (id) ON DELETE SET NULL,
  external_ref TEXT,
  link_generation INTEGER NOT NULL DEFAULT 1,
  next_sync_at INTEGER,
  last_synced_at INTEGER,
  sync_error_code TEXT,
  sync_failures INTEGER NOT NULL DEFAULT 0,
  refresh_requested_at INTEGER,
  last_refreshed_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  -- Set by the application in the same statement that changes object_key; the triggers consume them.
  pending_cause TEXT NOT NULL DEFAULT 'admin'
    CHECK (pending_cause IN ('create', 'admin', 'api', 'connection', 'user_refresh', 'template_upgrade', 'resign')),
  pending_actor_type TEXT,
  pending_actor_id TEXT,
  pending_pass_json TEXT,
  UNIQUE (identity_id, serial),
  FOREIGN KEY (template_id, template_version) REFERENCES template_versions (template_id, version)
);
CREATE INDEX passes_org_list ON passes (org_id, template_id, status, display_title);
CREATE INDEX passes_external ON passes (org_id, external_id);
CREATE INDEX passes_template ON passes (template_id, template_version);
CREATE INDEX passes_connection_ref ON passes (connection_id, external_ref) WHERE connection_id IS NOT NULL;
CREATE INDEX passes_sync_due ON passes (next_sync_at) WHERE next_sync_at IS NOT NULL;
CREATE INDEX passes_revision ON passes (identity_id, revision);
CREATE INDEX passes_holder_email ON passes (holder_email) WHERE holder_email IS NOT NULL;
CREATE INDEX passes_owner ON passes (owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE TABLE pass_versions (
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  object_key TEXT,
  object_sha256 TEXT,
  template_version TEXT NOT NULL,
  personalization TEXT NOT NULL CHECK (json_valid(personalization)),
  pass_json TEXT,
  cause TEXT NOT NULL
    CHECK (cause IN ('create', 'admin', 'api', 'connection', 'user_refresh', 'template_upgrade', 'resign')),
  actor_type TEXT,
  actor_id TEXT,
  created_at INTEGER NOT NULL,
  purged_at INTEGER,
  PRIMARY KEY (pass_id, version)
);

CREATE TABLE pass_attach_blocks (
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pass_id, user_id)
);
CREATE INDEX pass_attach_blocks_user ON pass_attach_blocks (user_id);

CREATE TABLE pass_assets (
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  sha1 TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pass_id, name)
);

-- Apple device protocol

CREATE TABLE devices (
  device_id TEXT NOT NULL,
  identity_id TEXT NOT NULL REFERENCES signing_identities (id) ON DELETE CASCADE,
  push_token TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, identity_id)
);
CREATE INDEX devices_identity ON devices (identity_id);
CREATE INDEX devices_token ON devices (push_token);

CREATE TABLE registrations (
  device_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, identity_id, pass_id),
  FOREIGN KEY (device_id, identity_id) REFERENCES devices (device_id, identity_id) ON DELETE CASCADE
);
CREATE INDEX registrations_pass ON registrations (pass_id);

CREATE TRIGGER registrations_cap
BEFORE INSERT ON registrations
WHEN (SELECT count(*) FROM registrations WHERE pass_id = NEW.pass_id) >= 20
BEGIN
  SELECT RAISE(ABORT, 'registration cap reached');
END;

-- AUTOINCREMENT keeps the high-water mark in sqlite_sequence after pruning. Never reset it.
CREATE TABLE revisions (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX revisions_at ON revisions (at);

-- Delivery

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('push', 'email')),
  pass_id TEXT REFERENCES passes (id) ON DELETE CASCADE,
  coalesce_key TEXT UNIQUE,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'enqueued', 'processing', 'sent', 'partial', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  available_at INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER,
  lease TEXT,
  provider_id TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX outbox_due ON outbox (state, available_at);
CREATE INDEX outbox_pass ON outbox (pass_id, created_at DESC);
CREATE INDEX outbox_org ON outbox (org_id, created_at DESC);

CREATE TABLE push_results (
  outbox_id TEXT NOT NULL REFERENCES outbox (id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  http_status INTEGER,
  reason TEXT,
  apns_id TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (outbox_id, device_id)
);

CREATE TABLE wallet_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  identity_id TEXT,
  line TEXT NOT NULL
);
CREATE INDEX wallet_logs_at ON wallet_logs (at);

-- Audit, settings, idempotency

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  org_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system', 'connection', 'device')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  request_id TEXT,
  ip_prefix TEXT,
  detail TEXT CHECK (detail IS NULL OR json_valid(detail))
);
CREATE INDEX audit_org ON audit_log (org_id, at DESC);
CREATE INDEX audit_target ON audit_log (target_type, target_id, at DESC);
CREATE INDEX audit_at ON audit_log (at);

CREATE TABLE settings (
  scope TEXT NOT NULL CHECK (scope IN ('platform', 'system') OR scope GLOB 'org:*'),
  key TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE idempotency_keys (
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  resource_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, key)
);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);

CREATE TABLE counters (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE workflow_runs (
  instance_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('template_import', 'bulk_reissue', 'connection_sync')),
  org_id TEXT,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'errored', 'terminated')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_code TEXT
);
CREATE INDEX workflow_runs_kind ON workflow_runs (kind, started_at DESC);
CREATE INDEX workflow_runs_target ON workflow_runs (target_id, started_at DESC);

-- Publish triggers: bump the revision, record the version, coalesce one pending push per pass.

CREATE TRIGGER pass_created
AFTER INSERT ON passes
BEGIN
  INSERT INTO revisions (pass_id, at) VALUES (NEW.id, NEW.modified_at);
  UPDATE passes
    SET revision = last_insert_rowid(), pending_pass_json = NULL, pending_cause = 'admin',
        pending_actor_type = NULL, pending_actor_id = NULL
    WHERE id = NEW.id;
  INSERT INTO pass_versions (pass_id, version, object_key, object_sha256, template_version,
                             personalization, pass_json, cause, actor_type, actor_id, created_at)
    VALUES (NEW.id, NEW.version, NEW.object_key, NEW.object_sha256, NEW.template_version,
            NEW.personalization, NEW.pending_pass_json,
            'create',
            NEW.pending_actor_type, NEW.pending_actor_id, NEW.modified_at);
END;

CREATE TRIGGER pass_published
AFTER UPDATE OF object_key ON passes
WHEN NEW.object_key != OLD.object_key
BEGIN
  INSERT INTO revisions (pass_id, at) VALUES (NEW.id, NEW.modified_at);
  UPDATE passes
    SET revision = last_insert_rowid(), pending_pass_json = NULL, pending_cause = 'admin',
        pending_actor_type = NULL, pending_actor_id = NULL
    WHERE id = NEW.id;
  INSERT INTO pass_versions (pass_id, version, object_key, object_sha256, template_version,
                             personalization, pass_json, cause, actor_type, actor_id, created_at)
    VALUES (NEW.id, NEW.version, NEW.object_key, NEW.object_sha256, NEW.template_version,
            NEW.personalization, NEW.pending_pass_json, NEW.pending_cause,
            NEW.pending_actor_type, NEW.pending_actor_id, NEW.modified_at);
  INSERT OR IGNORE INTO outbox (id, org_id, kind, pass_id, coalesce_key, state, available_at, created_at)
    VALUES ('push:' || NEW.id || ':' || NEW.version, NEW.org_id, 'push', NEW.id,
            'push:' || NEW.id, 'pending', 0, NEW.modified_at);
END;

-- Template import progress.
CREATE TABLE template_imports (
  upload_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name TEXT,
  object_key TEXT NOT NULL,
  step TEXT,
  template_id TEXT,
  version TEXT,
  report TEXT CHECK (report IS NULL OR json_valid(report)),
  error TEXT,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX template_imports_org ON template_imports (org_id, created_at DESC);
CREATE INDEX template_imports_created_by ON template_imports (created_by);

-- Keyset pagination of the admin pass list (newest first, optionally per org).
CREATE INDEX passes_org_id ON passes (org_id, id DESC);

-- Records delivered inside a signed webhook body; the queue message carries only refs.

-- Records delivered inside a signed webhook body. The queue message carries only refs; the job reads these.
CREATE TABLE connection_inbox (
  connection_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  record TEXT CHECK (record IS NULL OR json_valid(record)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  received_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, event_id, ref),
  FOREIGN KEY (connection_id, event_id) REFERENCES webhook_events (connection_id, event_id) ON DELETE CASCADE
);
CREATE INDEX connection_inbox_received ON connection_inbox (received_at);

-- Range indexes for the D1 metrics fallback (admin overview).
CREATE INDEX pass_versions_created ON pass_versions (created_at);
CREATE INDEX registrations_created ON registrations (created_at);
CREATE INDEX outbox_kind_created ON outbox (kind, created_at);
CREATE INDEX connection_runs_started ON connection_runs (started_at);

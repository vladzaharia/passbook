-- Wallet account model (design-wallet-accounts.md rev 3). A credential is the provider secret, scoped to
-- the platform or to one org, and rotates in place as append-only versions. An enrolment is the existing
-- wallet_provider_accounts row per (org, mode, provider): it keeps its id and HMAC key and points at one
-- credential as its source. Enrolment state moves only with an event row, and the triggers below hold the
-- rules, so no writer can bypass them.
-- Exception to the 0037 header: identity_hash (unkeyed SHA-256) with identity_hint (last 4 characters) is
-- effectively plaintext on purpose: it is how a shared issuer is detected.

-- A new-model enrolment has no legacy credential: revision 0 and no credential_id, and it can still be revoked.
-- The 0037 CHECK refused revoked_at there, so the table is rebuilt with `(revision = 0) = (credential_id IS NULL)`;
-- a legacy row (revision > 0) still needs its credential_id. The rebuild also adds the HMAC envelope columns and their trigger (A1). Nothing else changes: columns, keys, the 0037 and
-- 0043 triggers (recreated as they were) and every row. Children point at the id, so their checks are deferred
-- until the rows are back. tools/wallet-accounts-rebuild.test.ts diffs the schema across this block.
-- rebuild:begin
PRAGMA defer_foreign_keys = ON;
CREATE TABLE _keep_wallet_provider_accounts AS SELECT * FROM wallet_provider_accounts;
DROP TABLE wallet_provider_accounts;
CREATE TABLE wallet_provider_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'samsung')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0),
  credential_id TEXT,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  hmac_kek_version INTEGER CHECK (hmac_kek_version IS NULL OR hmac_kek_version > 0),
  hmac_iv BLOB,
  hmac_wrapped_dek BLOB,
  hmac_ciphertext BLOB,
  UNIQUE (org_id, mode, provider),
  UNIQUE (id, org_id, mode, provider),
  CHECK ((revision = 0) = (credential_id IS NULL)),
  CHECK ((hmac_kek_version IS NULL) = (hmac_iv IS NULL) AND (hmac_kek_version IS NULL) = (hmac_wrapped_dek IS NULL)
    AND (hmac_kek_version IS NULL) = (hmac_ciphertext IS NULL))
);
INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, revision, credential_id, revoked_at, created_at, updated_at)
  SELECT id, org_id, mode, provider, revision, credential_id, revoked_at, created_at, updated_at
  FROM _keep_wallet_provider_accounts;
DROP TABLE _keep_wallet_provider_accounts;
CREATE TRIGGER wallet_provider_accounts_no_delete BEFORE DELETE ON wallet_provider_accounts
BEGIN SELECT RAISE(ABORT, 'immutable wallet provider account'); END;
CREATE TRIGGER wallet_provider_accounts_transition BEFORE UPDATE ON wallet_provider_accounts
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
  OR NEW.provider IS NOT OLD.provider OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision != OLD.revision + 1
  OR NOT EXISTS (
    SELECT 1 FROM wallet_provider_account_events e
    JOIN wallet_provider_credentials c ON c.id = e.credential_id
      AND c.account_id = NEW.id AND c.org_id = NEW.org_id
      AND c.mode = NEW.mode AND c.provider = NEW.provider
    WHERE e.account_id = NEW.id AND e.org_id = NEW.org_id AND e.mode = NEW.mode
      AND e.provider = NEW.provider AND e.revision = NEW.revision
      AND e.credential_id = NEW.credential_id AND e.created_at = NEW.updated_at
      AND ((e.kind = 'configure' AND NEW.credential_id IS NOT OLD.credential_id AND NEW.revoked_at IS NULL)
        OR (e.kind = 'revoke' AND OLD.credential_id IS NOT NULL AND OLD.revoked_at IS NULL
            AND NEW.credential_id = OLD.credential_id
            AND NEW.revoked_at IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM wallet_provider_instances i WHERE i.account_id = OLD.id AND i.lifecycle != 'retired')))
  )
BEGIN SELECT RAISE(ABORT, 'invalid wallet provider account transition'); END;
CREATE TRIGGER wallet_provider_accounts_audit AFTER UPDATE ON wallet_provider_accounts
BEGIN
  INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
  SELECT e.created_at, e.org_id, 'user', e.actor_id, 'wallet_provider.account_' || e.kind,
    'wallet_provider_account', e.account_id, e.request_id, NULL,
    json_object('mode', e.mode, 'provider', e.provider, 'revision', e.revision)
  FROM wallet_provider_account_events e WHERE e.account_id = NEW.id AND e.revision = NEW.revision;
END;
CREATE TRIGGER wallet_provider_dirty_account AFTER UPDATE OF revision ON wallet_provider_accounts
WHEN OLD.revision IS NOT NEW.revision
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE account_id = NEW.id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;
-- The enrolment's own HMAC key (Google object ids), enveloped with AAD on account id, org, mode and provider.
-- Set once (NULL to a value, or copied from the v1 envelope by the migration); afterwards only a KEK rewrap
-- (kek_version up, wrapped_dek new) may touch it.
CREATE TRIGGER wallet_provider_accounts_hmac_immutable
BEFORE UPDATE OF hmac_kek_version, hmac_iv, hmac_wrapped_dek, hmac_ciphertext ON wallet_provider_accounts
WHEN OLD.hmac_ciphertext IS NOT NULL AND NOT (NEW.hmac_kek_version > OLD.hmac_kek_version
  AND NEW.hmac_wrapped_dek IS NOT OLD.hmac_wrapped_dek AND NEW.hmac_iv IS OLD.hmac_iv
  AND NEW.hmac_ciphertext IS OLD.hmac_ciphertext)
BEGIN SELECT RAISE(ABORT, 'immutable wallet account hmac key'); END;
-- rebuild:end

CREATE TABLE wallet_credentials (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('platform', 'org')),
  org_id TEXT REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'samsung')),
  identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64 AND identity_hash NOT GLOB '*[^0-9a-f]*'),
  identity_hint TEXT NOT NULL CHECK (length(identity_hint) BETWEEN 1 AND 4),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0),
  current_version_id TEXT,
  verified_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((scope = 'platform') = (org_id IS NULL)),
  CHECK (revision > 0 OR current_version_id IS NULL),
  CHECK (current_version_id IS NOT NULL OR revision = 0 OR revoked_at IS NOT NULL),
  FOREIGN KEY (current_version_id, id) REFERENCES wallet_credential_versions(id, credential_id)
);
CREATE INDEX wallet_credentials_org ON wallet_credentials(org_id);
CREATE INDEX wallet_credentials_version_fk ON wallet_credentials(current_version_id, id);
CREATE UNIQUE INDEX wallet_credentials_one_active ON wallet_credentials(COALESCE(org_id, ''), mode, provider)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX wallet_credentials_identity ON wallet_credentials(mode, provider, identity_hash)
  WHERE revoked_at IS NULL AND (scope = 'platform' OR verified_at IS NOT NULL);

-- Every version has a fresh encrypted envelope (rewrapped only: 0071). card_map is {"<type>": sha256(cardId)}.
CREATE TABLE wallet_credential_versions (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES wallet_credentials(id),
  identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64 AND identity_hash NOT GLOB '*[^0-9a-f]*'),
  card_map TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(card_map) AND json_type(card_map) = 'object'),
  kek_version INTEGER NOT NULL CHECK (kek_version > 0),
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (id, credential_id)
);
CREATE INDEX wallet_credential_versions_credential ON wallet_credential_versions(credential_id, created_at);

CREATE TABLE wallet_credential_events (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES wallet_credentials(id),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
  kind TEXT NOT NULL CHECK (kind IN ('create', 'rotate', 'revoke', 'verify')),
  version_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'platform', 'system')),
  actor_id TEXT,
  request_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (credential_id, revision),
  FOREIGN KEY (version_id, credential_id) REFERENCES wallet_credential_versions(id, credential_id),
  CHECK (kind NOT IN ('create', 'rotate') OR version_id IS NOT NULL),
  CHECK (actor_type = 'system' OR actor_id IS NOT NULL)
);
CREATE INDEX wallet_credential_events_version_fk ON wallet_credential_events(version_id, credential_id);

-- Only platform.job.wallet.credential_check writes these (authority-tables.ts RESTRICTED_TABLES); the
-- server clock stamps them, so the 24 h window an enable needs cannot be forged.
CREATE TABLE wallet_credential_checks (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES wallet_credentials(id),
  version_id TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  code TEXT CHECK (code IS NULL OR length(code) <= 64),
  checked_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  FOREIGN KEY (version_id, credential_id) REFERENCES wallet_credential_versions(id, credential_id)
);
CREATE INDEX wallet_credential_checks_version_fk ON wallet_credential_checks(version_id, credential_id);
CREATE INDEX wallet_credential_checks_credential ON wallet_credential_checks(credential_id);

ALTER TABLE wallet_provider_accounts ADD COLUMN credential_source_id TEXT REFERENCES wallet_credentials(id);
ALTER TABLE wallet_provider_accounts ADD COLUMN identity_hash TEXT
  CHECK (identity_hash IS NULL OR (length(identity_hash) = 64 AND identity_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE wallet_provider_accounts ADD COLUMN enabled_at INTEGER;
ALTER TABLE wallet_provider_accounts ADD COLUMN enrolment_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(enrolment_revision) = 'integer' AND enrolment_revision >= 0);
ALTER TABLE wallet_provider_accounts ADD COLUMN platform_hold_at INTEGER;
ALTER TABLE wallet_provider_accounts ADD COLUMN platform_hold_reason TEXT;
CREATE INDEX wallet_provider_accounts_source ON wallet_provider_accounts(credential_source_id);

CREATE TABLE wallet_enrolment_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider TEXT NOT NULL,
  enrolment_revision INTEGER NOT NULL CHECK (typeof(enrolment_revision) = 'integer' AND enrolment_revision > 0),
  kind TEXT NOT NULL CHECK (kind IN ('source', 'enable', 'disable', 'hold', 'release', 'revoke')),
  credential_id TEXT REFERENCES wallet_credentials(id),
  check_id TEXT REFERENCES wallet_credential_checks(id),
  round_trip_kind TEXT CHECK (round_trip_kind IN ('google_save', 'samsung_added')),
  round_trip_id TEXT,
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'platform', 'system')),
  actor_id TEXT,
  request_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (account_id, enrolment_revision),
  FOREIGN KEY (account_id, org_id, mode, provider)
    REFERENCES wallet_provider_accounts(id, org_id, mode, provider),
  CHECK ((round_trip_kind IS NULL) = (round_trip_id IS NULL)),
  CHECK (kind = 'enable' OR (check_id IS NULL AND round_trip_id IS NULL)),
  CHECK (kind NOT IN ('source', 'enable') OR credential_id IS NOT NULL),
  CHECK (kind != 'enable' OR check_id IS NOT NULL),
  CHECK (kind != 'hold' OR reason IS NOT NULL),
  CHECK (kind NOT IN ('hold', 'release') OR actor_type = 'platform'),
  CHECK (actor_type = 'system' OR actor_id IS NOT NULL)
);
CREATE INDEX wallet_enrolment_events_scope_fk ON wallet_enrolment_events(account_id, org_id, mode, provider);
CREATE INDEX wallet_enrolment_events_credential_fk ON wallet_enrolment_events(credential_id);
CREATE INDEX wallet_enrolment_events_check_fk ON wallet_enrolment_events(check_id);

ALTER TABLE wallet_provider_instance_operations ADD COLUMN credential_version_id TEXT
  REFERENCES wallet_credential_versions(id);
ALTER TABLE wallet_samsung_fetch_refs ADD COLUMN credential_version_id TEXT
  REFERENCES wallet_credential_versions(id);
ALTER TABLE wallet_samsung_tombstones ADD COLUMN credential_version_id TEXT
  REFERENCES wallet_credential_versions(id);
CREATE INDEX wallet_provider_operations_credential_version ON wallet_provider_instance_operations(credential_version_id);
CREATE INDEX wallet_samsung_fetch_refs_credential_version ON wallet_samsung_fetch_refs(credential_version_id);
CREATE INDEX wallet_samsung_tombstones_credential_version ON wallet_samsung_tombstones(credential_version_id);

-- Append-only history. A version is rewrap-only (0071) and must carry its credential's identity; a
-- revoked credential takes no more.
CREATE TRIGGER wallet_credential_versions_identity BEFORE INSERT ON wallet_credential_versions
WHEN NOT EXISTS (SELECT 1 FROM wallet_credentials c WHERE c.id = NEW.credential_id
  AND c.identity_hash = NEW.identity_hash AND c.revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'wallet credential version must keep the credential identity'); END;
CREATE TRIGGER wallet_credential_versions_no_update BEFORE UPDATE ON wallet_credential_versions
WHEN NOT (NEW.kek_version > OLD.kek_version AND NEW.wrapped_dek IS NOT OLD.wrapped_dek
  AND NEW.iv IS OLD.iv AND NEW.ciphertext IS OLD.ciphertext AND NEW.id IS OLD.id
  AND NEW.credential_id IS OLD.credential_id AND NEW.identity_hash IS OLD.identity_hash
  AND NEW.card_map IS OLD.card_map AND NEW.created_at IS OLD.created_at)
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential version'); END;
CREATE TRIGGER wallet_credential_versions_no_delete BEFORE DELETE ON wallet_credential_versions
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential version'); END;
CREATE TRIGGER wallet_credential_events_no_update BEFORE UPDATE ON wallet_credential_events
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential event'); END;
CREATE TRIGGER wallet_credential_events_no_delete BEFORE DELETE ON wallet_credential_events
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential event'); END;
CREATE TRIGGER wallet_credential_checks_no_update BEFORE UPDATE ON wallet_credential_checks
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential check'); END;
CREATE TRIGGER wallet_credential_checks_no_delete BEFORE DELETE ON wallet_credential_checks
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential check'); END;
CREATE TRIGGER wallet_enrolment_events_no_update BEFORE UPDATE ON wallet_enrolment_events
BEGIN SELECT RAISE(ABORT, 'immutable wallet enrolment event'); END;
CREATE TRIGGER wallet_enrolment_events_no_delete BEFORE DELETE ON wallet_enrolment_events
BEGIN SELECT RAISE(ABORT, 'immutable wallet enrolment event'); END;

-- The server clock stamps checks and events: an explicit value overrides a DEFAULT, so a value more than
-- 5 s from the clock is refused.
CREATE TRIGGER wallet_credential_checks_server_time BEFORE INSERT ON wallet_credential_checks
WHEN ABS(NEW.checked_at - CAST(unixepoch('subsec') * 1000 AS INTEGER)) > 5000
BEGIN SELECT RAISE(ABORT, 'wallet credential check needs the server clock'); END;
CREATE TRIGGER wallet_credential_events_server_time BEFORE INSERT ON wallet_credential_events
WHEN ABS(NEW.created_at - CAST(unixepoch('subsec') * 1000 AS INTEGER)) > 5000
BEGIN SELECT RAISE(ABORT, 'wallet credential event needs the server clock'); END;
CREATE TRIGGER wallet_enrolment_events_server_time BEFORE INSERT ON wallet_enrolment_events
WHEN ABS(NEW.created_at - CAST(unixepoch('subsec') * 1000 AS INTEGER)) > 5000
BEGIN SELECT RAISE(ABORT, 'wallet enrolment event needs the server clock'); END;

-- Who may write what is the database's rule too, not only the builder's: the grant row of the writing
-- batch exists while its statements run, so an event kind needs a grant of its org and mode with a
-- matching purpose. Hold and release are the platform's (a platform admin, or the hold job on a suspended
-- org); a source comes from the source, migration or migrate-job purposes; an enable only from the
-- enable purpose, and only while the org is active; a revoke (permanent) from the org's own revoke purpose
-- or a migration resolution, not from a disable or hold job.
CREATE TRIGGER authority_grants_wallet_platform_only BEFORE INSERT ON authority_grants
WHEN NEW.purpose IN ('org_mode.wallet.enrolment_hold', 'org_mode.wallet.enrolment_release',
    'org_mode.wallet.migration_resolve') AND NEW.principal NOT GLOB 'platform:*'
BEGIN SELECT RAISE(ABORT, 'wallet platform purposes are held by a platform admin'); END;
CREATE TRIGGER wallet_enrolment_events_platform_kinds BEFORE INSERT ON wallet_enrolment_events
WHEN NEW.kind IN ('hold', 'release') AND NOT EXISTS (
  SELECT 1 FROM authority_grants g WHERE g.org_id = NEW.org_id AND g.mode = NEW.mode
    AND ((NEW.kind = 'hold' AND g.purpose = 'org_mode.wallet.enrolment_hold' AND g.principal GLOB 'platform:*')
      OR (NEW.kind = 'hold' AND g.purpose = 'org_mode.job.wallet.enrolment_hold' AND g.principal GLOB 'system:*')
      OR (NEW.kind = 'release' AND g.purpose = 'org_mode.wallet.enrolment_release'
        AND g.principal GLOB 'platform:*')))
BEGIN SELECT RAISE(ABORT, 'wallet hold and release are the platform''s'); END;
CREATE TRIGGER wallet_enrolment_events_purpose BEFORE INSERT ON wallet_enrolment_events
WHEN NEW.kind IN ('source', 'enable', 'revoke') AND NOT EXISTS (
  SELECT 1 FROM authority_grants g WHERE g.org_id = NEW.org_id AND g.mode = NEW.mode
    AND ((NEW.kind = 'source' AND g.purpose IN ('org_mode.wallet.enrolment_source',
        'org_mode.wallet.migration_resolve', 'org_mode.job.wallet.credential_migrate'))
      OR (NEW.kind = 'enable' AND g.purpose = 'org_mode.wallet.enrolment_enable')
      OR (NEW.kind = 'revoke' AND g.purpose IN ('org_mode.wallet.enrolment_revoke',
        'org_mode.wallet.migration_resolve'))))
BEGIN SELECT RAISE(ABORT, 'wallet enrolment event does not match its grant'); END;
CREATE TRIGGER wallet_enrolment_events_enable_active BEFORE INSERT ON wallet_enrolment_events
WHEN NEW.kind = 'enable' AND NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.status = 'active')
BEGIN SELECT RAISE(ABORT, 'wallet enrolment enable needs an active org'); END;
CREATE TRIGGER wallet_credential_checks_job_only BEFORE INSERT ON wallet_credential_checks
WHEN NOT EXISTS (SELECT 1 FROM authority_grants g WHERE g.purpose = 'platform.job.wallet.credential_check'
  AND g.principal GLOB 'system:*')
BEGIN SELECT RAISE(ABORT, 'wallet credential checks are written by the check job'); END;

-- An event takes the account's next revision. Only a hold, a release (both the platform's) and a source_revoked disable may skip a gap, so
-- an unused event another writer left at the next revision cannot freeze the enrolment. A source or enable
-- names a platform credential or one of the same org's, not revoked.
CREATE TRIGGER wallet_enrolment_events_step BEFORE INSERT ON wallet_enrolment_events
WHEN NOT EXISTS (SELECT 1 FROM wallet_provider_accounts a WHERE a.id = NEW.account_id
  AND (NEW.enrolment_revision = a.enrolment_revision + 1
    OR (NEW.enrolment_revision > a.enrolment_revision
      AND (NEW.kind IN ('hold', 'release') OR (NEW.kind = 'disable' AND NEW.reason = 'source_revoked')))))
BEGIN SELECT RAISE(ABORT, 'wallet enrolment event needs the next revision'); END;
CREATE TRIGGER wallet_enrolment_events_credential BEFORE INSERT ON wallet_enrolment_events
WHEN NEW.kind IN ('source', 'enable') AND NOT EXISTS (
  SELECT 1 FROM wallet_credentials c WHERE c.id = NEW.credential_id AND c.revoked_at IS NULL
    AND (c.scope = 'platform' OR c.org_id = NEW.org_id))
BEGIN SELECT RAISE(ABORT, 'wallet enrolment event needs an available credential'); END;

-- Credential rules. It is inserted with no version; the first version is set by an UPDATE like every
-- rotation, so one guard covers both.
CREATE TRIGGER wallet_credentials_insert BEFORE INSERT ON wallet_credentials
WHEN NEW.revision != 0 OR NEW.current_version_id IS NOT NULL OR NEW.verified_at IS NOT NULL
  OR NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'wallet credential starts empty'); END;
CREATE TRIGGER wallet_credentials_platform_identity BEFORE INSERT ON wallet_credentials
WHEN NEW.scope = 'org' AND EXISTS (SELECT 1 FROM wallet_credentials p WHERE p.scope = 'platform'
  AND p.revoked_at IS NULL AND p.mode = NEW.mode AND p.provider = NEW.provider
  AND p.identity_hash = NEW.identity_hash)
BEGIN SELECT RAISE(ABORT, 'wallet identity belongs to the platform'); END;
CREATE TRIGGER wallet_credentials_immutable
BEFORE UPDATE OF id, scope, org_id, mode, provider, identity_hash, identity_hint, created_at ON wallet_credentials
WHEN NEW.id IS NOT OLD.id OR NEW.scope IS NOT OLD.scope OR NEW.org_id IS NOT OLD.org_id
  OR NEW.mode IS NOT OLD.mode OR NEW.provider IS NOT OLD.provider
  OR NEW.identity_hash IS NOT OLD.identity_hash OR NEW.identity_hint IS NOT OLD.identity_hint
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'wallet credential identity is immutable'); END;
CREATE TRIGGER wallet_credentials_no_delete BEFORE DELETE ON wallet_credentials
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential'); END;

-- Each state change is one revision with its event: create or rotate sets a version, revoke ends the
-- credential, verify needs a successful check of the current version.
CREATE TRIGGER wallet_credentials_step
BEFORE UPDATE OF revision, current_version_id, verified_at, revoked_at ON wallet_credentials
WHEN (NEW.revision IS NOT OLD.revision OR NEW.current_version_id IS NOT OLD.current_version_id
    OR NEW.verified_at IS NOT OLD.verified_at OR NEW.revoked_at IS NOT OLD.revoked_at)
  AND NOT (NEW.revision = OLD.revision + 1 AND EXISTS (
    SELECT 1 FROM wallet_credential_events e WHERE e.credential_id = NEW.id AND e.revision = NEW.revision
      AND ((e.kind = 'create' AND OLD.current_version_id IS NULL AND NEW.current_version_id = e.version_id
          AND NEW.verified_at IS OLD.verified_at AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL)
        OR (e.kind = 'rotate' AND OLD.current_version_id IS NOT NULL
          AND NEW.current_version_id = e.version_id AND NEW.current_version_id IS NOT OLD.current_version_id
          AND NEW.verified_at IS OLD.verified_at AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL)
        OR (e.kind = 'revoke' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
          AND NEW.current_version_id IS OLD.current_version_id AND NEW.verified_at IS OLD.verified_at)
        OR (e.kind = 'verify' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL
          AND NEW.current_version_id IS OLD.current_version_id AND NEW.verified_at = e.created_at
          AND EXISTS (SELECT 1 FROM wallet_credential_checks k WHERE k.credential_id = NEW.id
            AND k.version_id = NEW.current_version_id AND k.ok = 1)))))
BEGIN SELECT RAISE(ABORT, 'invalid wallet credential transition'); END;
-- A rotation keeps every card id: the card map only grows.
CREATE TRIGGER wallet_credentials_card_map_append BEFORE UPDATE OF current_version_id ON wallet_credentials
WHEN OLD.current_version_id IS NOT NULL AND NEW.current_version_id IS NOT OLD.current_version_id
  AND EXISTS (SELECT 1 FROM wallet_credential_versions o, json_each(o.card_map) k
    WHERE o.id = OLD.current_version_id AND NOT EXISTS (
      SELECT 1 FROM wallet_credential_versions n, json_each(n.card_map) m
      WHERE n.id = NEW.current_version_id AND m.key = k.key AND m.value IS k.value))
BEGIN SELECT RAISE(ABORT, 'wallet credential card map is append-only'); END;
CREATE TRIGGER wallet_credentials_revoke_guard BEFORE UPDATE OF revoked_at ON wallet_credentials
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM wallet_provider_accounts a JOIN wallet_provider_instances i ON i.account_id = a.id
  WHERE a.credential_source_id = OLD.id AND i.lifecycle != 'retired')
BEGIN SELECT RAISE(ABORT, 'wallet credential is in use'); END;
-- Revoking a source turns every enrolment on it Off, with a disable event under the revoker's name. The event
-- takes the account's highest revision + 1, so an event another writer left at the next revision cannot block
-- a revoke (the step trigger lets this one reason skip such a gap).
CREATE TRIGGER wallet_credentials_revoke_off AFTER UPDATE OF revoked_at ON wallet_credentials
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO wallet_enrolment_events (id, account_id, org_id, mode, provider, enrolment_revision, kind,
    credential_id, reason, actor_type, actor_id, request_id, created_at)
  SELECT lower(hex(randomblob(16))), a.id, a.org_id, a.mode, a.provider,
    MAX(a.enrolment_revision, COALESCE((SELECT MAX(x.enrolment_revision) FROM wallet_enrolment_events x
      WHERE x.account_id = a.id), 0)) + 1,
    'disable', NEW.id, 'source_revoked', r.actor_type, r.actor_id, r.request_id,
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM wallet_provider_accounts a
  JOIN wallet_credential_events r ON r.credential_id = NEW.id AND r.revision = NEW.revision
  WHERE a.credential_source_id = NEW.id AND a.enabled_at IS NOT NULL;
  UPDATE wallet_provider_accounts SET enabled_at = NULL, enrolment_revision = (
    SELECT MAX(e.enrolment_revision) FROM wallet_enrolment_events e
    WHERE e.account_id = wallet_provider_accounts.id AND e.kind = 'disable' AND e.reason = 'source_revoked'
      AND e.credential_id = NEW.id)
  WHERE credential_source_id = NEW.id AND enabled_at IS NOT NULL;
END;
CREATE TRIGGER wallet_credentials_audit AFTER UPDATE OF revision ON wallet_credentials
WHEN NEW.revision IS NOT OLD.revision
BEGIN
  INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
  SELECT e.created_at, NEW.org_id, CASE e.actor_type WHEN 'system' THEN 'system' ELSE 'user' END, e.actor_id,
    'wallet_provider.credential_' || e.kind, 'wallet_credential', NEW.id, e.request_id, NULL,
    json_object('mode', NEW.mode, 'provider', NEW.provider, 'scope', NEW.scope, 'revision', e.revision,
      'actor', e.actor_type)
  FROM wallet_credential_events e WHERE e.credential_id = NEW.id AND e.revision = NEW.revision;
END;

-- Narrow the 0037 triggers: they fired on every column, so the enrolment columns could not move. The
-- configure and revoke transitions are unchanged, and a revoke needs the enrolment Off. A new-model
-- enrolment (no legacy credential_id) is revoked by a revoke event instead, checked by
-- wallet_enrolments_revoke_* below.
DROP TRIGGER wallet_provider_accounts_transition;
CREATE TRIGGER wallet_provider_accounts_transition
BEFORE UPDATE OF id, org_id, mode, provider, created_at, revision, credential_id, revoked_at ON wallet_provider_accounts
WHEN NOT (OLD.credential_id IS NULL AND NEW.credential_id IS NULL AND NEW.revision = OLD.revision
    AND NEW.id IS OLD.id AND NEW.org_id IS OLD.org_id AND NEW.mode IS OLD.mode
    AND NEW.provider IS OLD.provider AND NEW.created_at IS OLD.created_at
    AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  AND (NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
  OR NEW.provider IS NOT OLD.provider OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision != OLD.revision + 1
  OR NOT EXISTS (
    SELECT 1 FROM wallet_provider_account_events e
    JOIN wallet_provider_credentials c ON c.id = e.credential_id
      AND c.account_id = NEW.id AND c.org_id = NEW.org_id
      AND c.mode = NEW.mode AND c.provider = NEW.provider
    WHERE e.account_id = NEW.id AND e.org_id = NEW.org_id AND e.mode = NEW.mode
      AND e.provider = NEW.provider AND e.revision = NEW.revision
      AND e.credential_id = NEW.credential_id AND e.created_at = NEW.updated_at
      AND ((e.kind = 'configure' AND NEW.credential_id IS NOT OLD.credential_id AND NEW.revoked_at IS NULL)
        OR (e.kind = 'revoke' AND OLD.credential_id IS NOT NULL AND OLD.revoked_at IS NULL
            AND NEW.credential_id = OLD.credential_id
            AND NEW.revoked_at IS NOT NULL AND OLD.enabled_at IS NULL AND NEW.enabled_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM wallet_provider_instances i WHERE i.account_id = OLD.id AND i.lifecycle != 'retired')))
  ))
BEGIN SELECT RAISE(ABORT, 'invalid wallet provider account transition'); END;

DROP TRIGGER wallet_provider_accounts_audit;
CREATE TRIGGER wallet_provider_accounts_audit AFTER UPDATE OF revision ON wallet_provider_accounts
BEGIN
  INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
  SELECT e.created_at, e.org_id, 'user', e.actor_id, 'wallet_provider.account_' || e.kind,
    'wallet_provider_account', e.account_id, e.request_id, NULL,
    json_object('mode', e.mode, 'provider', e.provider, 'revision', e.revision)
  FROM wallet_provider_account_events e WHERE e.account_id = NEW.id AND e.revision = NEW.revision;
END;

-- Enrolment rules. It is inserted with no source, no identity and Off, so the first source is an UPDATE.
CREATE TRIGGER wallet_enrolments_insert BEFORE INSERT ON wallet_provider_accounts
WHEN NEW.credential_source_id IS NOT NULL OR NEW.identity_hash IS NOT NULL OR NEW.enabled_at IS NOT NULL
  OR NEW.enrolment_revision != 0 OR NEW.platform_hold_at IS NOT NULL OR NEW.platform_hold_reason IS NOT NULL
  OR NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'wallet enrolment starts without a source'); END;

-- Every change of source, identity, state or hold is one enrolment_revision step with its event. Only a
-- source_revoked disable may skip a gap of unused revisions.
CREATE TRIGGER wallet_enrolments_step
BEFORE UPDATE OF credential_source_id, identity_hash, enabled_at, enrolment_revision, platform_hold_at,
  platform_hold_reason ON wallet_provider_accounts
WHEN (NEW.credential_source_id IS NOT OLD.credential_source_id OR NEW.identity_hash IS NOT OLD.identity_hash
    OR NEW.enabled_at IS NOT OLD.enabled_at OR NEW.enrolment_revision IS NOT OLD.enrolment_revision
    OR NEW.platform_hold_at IS NOT OLD.platform_hold_at
    OR NEW.platform_hold_reason IS NOT OLD.platform_hold_reason)
  AND NOT (NEW.enrolment_revision > OLD.enrolment_revision AND EXISTS (
    SELECT 1 FROM wallet_enrolment_events e
    WHERE e.account_id = NEW.id AND e.enrolment_revision = NEW.enrolment_revision
      AND (NEW.enrolment_revision = OLD.enrolment_revision + 1
        OR e.kind IN ('hold', 'release') OR (e.kind = 'disable' AND e.reason = 'source_revoked'))
      AND (NEW.revoked_at IS OLD.revoked_at OR e.kind = 'revoke')
      AND ((e.kind = 'source' AND e.credential_id = NEW.credential_source_id
          AND NEW.credential_source_id IS NOT OLD.credential_source_id AND NEW.enabled_at IS NULL AND OLD.revoked_at IS NULL
          AND NEW.platform_hold_at IS OLD.platform_hold_at
          AND NEW.platform_hold_reason IS OLD.platform_hold_reason)
        OR (e.kind = 'enable' AND OLD.enabled_at IS NULL AND NEW.enabled_at = e.created_at
          AND NEW.credential_source_id IS OLD.credential_source_id AND NEW.identity_hash IS OLD.identity_hash
          AND NEW.platform_hold_at IS OLD.platform_hold_at
          AND NEW.platform_hold_reason IS OLD.platform_hold_reason)
        OR (e.kind = 'disable' AND OLD.enabled_at IS NOT NULL AND NEW.enabled_at IS NULL
          AND NEW.credential_source_id IS OLD.credential_source_id AND NEW.identity_hash IS OLD.identity_hash
          AND NEW.platform_hold_at IS OLD.platform_hold_at
          AND NEW.platform_hold_reason IS OLD.platform_hold_reason)
        OR (e.kind = 'hold' AND OLD.platform_hold_at IS NULL AND NEW.platform_hold_at = e.created_at
          AND NEW.platform_hold_reason IS e.reason AND NEW.enabled_at IS NULL
          AND NEW.credential_source_id IS OLD.credential_source_id AND NEW.identity_hash IS OLD.identity_hash)
        OR (e.kind = 'release' AND OLD.platform_hold_at IS NOT NULL AND NEW.platform_hold_at IS NULL
          AND NEW.platform_hold_reason IS NULL AND NEW.enabled_at IS OLD.enabled_at
          AND NEW.credential_source_id IS OLD.credential_source_id AND NEW.identity_hash IS OLD.identity_hash)
        OR (e.kind = 'revoke' AND OLD.revoked_at IS NULL AND NEW.revoked_at = e.created_at
          AND OLD.enabled_at IS NULL AND NEW.enabled_at IS NULL
          AND NEW.credential_source_id IS OLD.credential_source_id AND NEW.identity_hash IS OLD.identity_hash
          AND NEW.platform_hold_at IS OLD.platform_hold_at
          AND NEW.platform_hold_reason IS OLD.platform_hold_reason))))
BEGIN SELECT RAISE(ABORT, 'wallet enrolment change needs its event'); END;

-- Revoking a new-model enrolment (no legacy credential_id; the legacy row keeps its own transition above):
-- a revoke event at the next revision stamps revoked_at, the enrolment is Off, and no instance is unretired.
CREATE TRIGGER wallet_enrolments_revoke_event BEFORE UPDATE OF revoked_at ON wallet_provider_accounts
WHEN OLD.credential_id IS NULL AND NEW.revoked_at IS NOT OLD.revoked_at AND NOT (
  OLD.revoked_at IS NULL AND NEW.enrolment_revision = OLD.enrolment_revision + 1 AND EXISTS (
    SELECT 1 FROM wallet_enrolment_events e WHERE e.account_id = NEW.id
      AND e.enrolment_revision = NEW.enrolment_revision AND e.kind = 'revoke' AND e.created_at = NEW.revoked_at))
BEGIN SELECT RAISE(ABORT, 'wallet enrolment revoke needs its event'); END;
CREATE TRIGGER wallet_enrolments_revoke_off BEFORE UPDATE OF revoked_at ON wallet_provider_accounts
WHEN OLD.credential_id IS NULL AND NEW.revoked_at IS NOT OLD.revoked_at
  AND (OLD.enabled_at IS NOT NULL OR NEW.enabled_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'wallet enrolment revoke needs it off'); END;
CREATE TRIGGER wallet_enrolments_revoke_in_use BEFORE UPDATE OF revoked_at ON wallet_provider_accounts
WHEN OLD.credential_id IS NULL AND NEW.revoked_at IS NOT OLD.revoked_at AND EXISTS (
  SELECT 1 FROM wallet_provider_instances i WHERE i.account_id = OLD.id AND i.lifecycle != 'retired')
BEGIN SELECT RAISE(ABORT, 'wallet enrolment is in use'); END;

-- Source guard: an active credential of the same mode and provider, the platform's or this org's own,
-- with its identity; a switch turns the enrolment Off; an identity change needs no unretired instances.
CREATE TRIGGER wallet_enrolments_identity_follows_source BEFORE UPDATE OF identity_hash ON wallet_provider_accounts
WHEN NEW.identity_hash IS NOT OLD.identity_hash AND NEW.credential_source_id IS OLD.credential_source_id
BEGIN SELECT RAISE(ABORT, 'wallet enrolment identity follows its source'); END;
CREATE TRIGGER wallet_enrolments_source_guard BEFORE UPDATE OF credential_source_id, identity_hash ON wallet_provider_accounts
WHEN NEW.credential_source_id IS NOT OLD.credential_source_id AND NOT EXISTS (
  SELECT 1 FROM wallet_credentials c WHERE c.id = NEW.credential_source_id AND c.revoked_at IS NULL
    AND c.current_version_id IS NOT NULL AND c.mode = NEW.mode AND c.provider = NEW.provider
    AND (c.scope = 'platform' OR c.org_id = NEW.org_id) AND c.identity_hash IS NEW.identity_hash)
BEGIN SELECT RAISE(ABORT, 'wallet enrolment source is unavailable'); END;
CREATE TRIGGER wallet_enrolments_switch_off BEFORE UPDATE OF credential_source_id ON wallet_provider_accounts
WHEN NEW.credential_source_id IS NOT OLD.credential_source_id AND NEW.enabled_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'wallet enrolment source switch turns it off'); END;
CREATE TRIGGER wallet_enrolments_identity_in_use BEFORE UPDATE OF identity_hash ON wallet_provider_accounts
WHEN OLD.identity_hash IS NOT NULL AND NEW.identity_hash IS NOT OLD.identity_hash AND EXISTS (
  SELECT 1 FROM wallet_provider_instances i WHERE i.account_id = NEW.id AND i.lifecycle != 'retired')
BEGIN SELECT RAISE(ABORT, 'wallet enrolment identity change needs retired instances'); END;

-- Enable guard. The event names the source, a successful check of its current version from the last
-- 24 h, and for Live a Test round trip received after the Test enrolment's last source event.
CREATE TRIGGER wallet_enrolments_enable_hold BEFORE UPDATE OF enabled_at ON wallet_provider_accounts
WHEN OLD.enabled_at IS NULL AND NEW.enabled_at IS NOT NULL AND NEW.platform_hold_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'wallet enrolment is held by the platform'); END;
CREATE TRIGGER wallet_enrolments_enable_source BEFORE UPDATE OF enabled_at ON wallet_provider_accounts
WHEN OLD.enabled_at IS NULL AND NEW.enabled_at IS NOT NULL AND (NEW.revoked_at IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM wallet_credentials c WHERE c.id = NEW.credential_source_id AND c.revoked_at IS NULL
    AND c.current_version_id IS NOT NULL AND c.mode = NEW.mode AND c.provider = NEW.provider
    AND (c.scope = 'platform' OR c.org_id = NEW.org_id) AND c.identity_hash IS NEW.identity_hash))
BEGIN SELECT RAISE(ABORT, 'wallet enrolment enable needs an active source'); END;
CREATE TRIGGER wallet_enrolments_enable_verified BEFORE UPDATE OF enabled_at ON wallet_provider_accounts
WHEN OLD.enabled_at IS NULL AND NEW.enabled_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM wallet_credentials c WHERE c.id = NEW.credential_source_id AND c.scope = 'org'
    AND c.verified_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'wallet enrolment enable needs a verified source'); END;
CREATE TRIGGER wallet_enrolments_enable_check BEFORE UPDATE OF enabled_at ON wallet_provider_accounts
WHEN OLD.enabled_at IS NULL AND NEW.enabled_at IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM wallet_enrolment_events e
  JOIN wallet_credentials c ON c.id = e.credential_id
  JOIN wallet_credential_checks k ON k.id = e.check_id AND k.credential_id = c.id
    AND k.version_id = c.current_version_id
  WHERE e.account_id = NEW.id AND e.enrolment_revision = NEW.enrolment_revision AND e.kind = 'enable'
    AND e.credential_id = NEW.credential_source_id AND k.ok = 1
    AND k.checked_at >= CAST(unixepoch('subsec') * 1000 AS INTEGER) - 86400000)
BEGIN SELECT RAISE(ABORT, 'wallet enrolment enable needs a fresh credential check'); END;
CREATE TRIGGER wallet_enrolments_enable_round_trip BEFORE UPDATE OF enabled_at ON wallet_provider_accounts
WHEN OLD.enabled_at IS NULL AND NEW.enabled_at IS NOT NULL AND NEW.mode = 'live' AND NOT EXISTS (
  SELECT 1 FROM wallet_enrolment_events e
  JOIN wallet_provider_accounts t ON t.org_id = NEW.org_id AND t.mode = 'test' AND t.provider = NEW.provider
    AND t.credential_source_id IS NOT NULL
  WHERE e.account_id = NEW.id AND e.enrolment_revision = NEW.enrolment_revision AND e.kind = 'enable'
    AND ((NEW.provider = 'google' AND e.round_trip_kind = 'google_save' AND EXISTS (
        SELECT 1 FROM wallet_google_callback_receipts r WHERE r.id = e.round_trip_id
          AND r.account_id = t.id AND r.org_id = t.org_id AND r.mode = 'test' AND r.event_type = 'save'
          AND r.received_at > COALESCE((SELECT MAX(s.created_at) FROM wallet_enrolment_events s
            WHERE s.account_id = t.id AND s.kind = 'source'), 0)))
      OR (NEW.provider = 'samsung' AND e.round_trip_kind = 'samsung_added' AND EXISTS (
        SELECT 1 FROM wallet_samsung_callback_receipts r WHERE r.id = e.round_trip_id
          AND r.account_id = t.id AND r.org_id = t.org_id AND r.mode = 'test' AND r.event = 'ADDED'
          AND r.received_at > COALESCE((SELECT MAX(s.created_at) FROM wallet_enrolment_events s
            WHERE s.account_id = t.id AND s.kind = 'source'), 0)))))
BEGIN SELECT RAISE(ABORT, 'wallet enrolment enable needs a Test round trip'); END;

-- Audit comes in the transaction of the accepted step. Dirty fires on a state or source change, not on
-- a rotation.
CREATE TRIGGER wallet_enrolments_audit AFTER UPDATE OF enrolment_revision ON wallet_provider_accounts
WHEN NEW.enrolment_revision IS NOT OLD.enrolment_revision
BEGIN
  INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
  SELECT e.created_at, e.org_id, CASE e.actor_type WHEN 'system' THEN 'system' ELSE 'user' END, e.actor_id,
    'wallet_provider.enrolment_' || e.kind, 'wallet_provider_account', e.account_id, e.request_id, NULL,
    json_object('mode', e.mode, 'provider', e.provider, 'enrolment_revision', e.enrolment_revision,
      'reason', e.reason, 'actor', e.actor_type)
  FROM wallet_enrolment_events e WHERE e.account_id = NEW.id AND e.enrolment_revision = NEW.enrolment_revision;
END;
CREATE TRIGGER wallet_provider_dirty_enrolment AFTER UPDATE OF enabled_at, credential_source_id ON wallet_provider_accounts
WHEN OLD.enabled_at IS NOT NEW.enabled_at OR OLD.credential_source_id IS NOT NEW.credential_source_id
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE account_id = NEW.id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;

-- Pins: an op or fetch reference names the credential version it was made under, which belongs to the
-- enrolment's source. NULL is legacy and allowed only while the enrolment has no source. A tombstone
-- copies the pin of its reference. An instance with no account is the 0043 guards' to refuse.
CREATE TRIGGER wallet_provider_operation_credential_pin BEFORE INSERT ON wallet_provider_instance_operations
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances x WHERE x.id = NEW.instance_id AND x.account_id IS NOT NULL)
  AND NOT EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_accounts a ON a.id = i.account_id
  WHERE i.id = NEW.instance_id AND ((NEW.credential_version_id IS NULL AND a.credential_source_id IS NULL)
    OR EXISTS (SELECT 1 FROM wallet_credential_versions v WHERE v.id = NEW.credential_version_id
      AND v.credential_id = a.credential_source_id)))
BEGIN SELECT RAISE(ABORT, 'wallet credential pin must belong to the enrolment source'); END;
CREATE TRIGGER wallet_samsung_ref_credential_pin BEFORE INSERT ON wallet_samsung_fetch_refs
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances x WHERE x.id = NEW.instance_id AND x.account_id IS NOT NULL)
  AND NOT EXISTS (
  SELECT 1 FROM wallet_provider_instances i JOIN wallet_provider_accounts a ON a.id = i.account_id
  WHERE i.id = NEW.instance_id AND ((NEW.credential_version_id IS NULL AND a.credential_source_id IS NULL)
    OR EXISTS (SELECT 1 FROM wallet_credential_versions v WHERE v.id = NEW.credential_version_id
      AND v.credential_id = a.credential_source_id)))
BEGIN SELECT RAISE(ABORT, 'wallet credential pin must belong to the enrolment source'); END;
CREATE TRIGGER wallet_samsung_tombstone_credential_pin BEFORE INSERT ON wallet_samsung_tombstones
WHEN NEW.credential_version_id IS NOT (SELECT r.credential_version_id FROM wallet_samsung_fetch_refs r
  WHERE r.ref_hash = NEW.ref_hash)
BEGIN SELECT RAISE(ABORT, 'wallet tombstone copies the pin of its reference'); END;
CREATE TRIGGER wallet_provider_operation_credential_version_immutable
BEFORE UPDATE OF credential_version_id, instance_id ON wallet_provider_instance_operations
WHEN NEW.credential_version_id IS NOT OLD.credential_version_id OR NEW.instance_id IS NOT OLD.instance_id
BEGIN SELECT RAISE(ABORT, 'wallet credential pin is immutable'); END;
CREATE TRIGGER wallet_samsung_ref_credential_version_immutable
BEFORE UPDATE OF credential_version_id ON wallet_samsung_fetch_refs
WHEN NEW.credential_version_id IS NOT OLD.credential_version_id
BEGIN SELECT RAISE(ABORT, 'wallet credential pin is immutable'); END;

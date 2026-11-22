-- An enrolment event can name an API key as its actor, so an enable made through the pass-setup API is
-- attributed to the key (and its audit row says api_key), not to the system. SQLite cannot change a CHECK,
-- so the table is rebuilt as it was with one more actor type; rows, indexes and triggers are unchanged
-- (the 0136 delete rule and the 0156 sandbox rule included) and the audit trigger learns the new type.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE _keep_wallet_enrolment_events AS SELECT * FROM wallet_enrolment_events;
DROP TABLE wallet_enrolment_events;
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
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'platform', 'system', 'api_key')),
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
INSERT INTO wallet_enrolment_events SELECT * FROM _keep_wallet_enrolment_events;
DROP TABLE _keep_wallet_enrolment_events;
CREATE INDEX wallet_enrolment_events_scope_fk ON wallet_enrolment_events(account_id, org_id, mode, provider);
CREATE INDEX wallet_enrolment_events_credential_fk ON wallet_enrolment_events(credential_id);
CREATE INDEX wallet_enrolment_events_check_fk ON wallet_enrolment_events(check_id);

CREATE TRIGGER wallet_enrolment_events_no_update BEFORE UPDATE ON wallet_enrolment_events
BEGIN SELECT RAISE(ABORT, 'immutable wallet enrolment event'); END;
CREATE TRIGGER wallet_enrolment_events_server_time BEFORE INSERT ON wallet_enrolment_events
WHEN ABS(NEW.created_at - CAST(unixepoch('subsec') * 1000 AS INTEGER)) > 5000
BEGIN SELECT RAISE(ABORT, 'wallet enrolment event needs the server clock'); END;
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
CREATE TRIGGER wallet_enrolment_events_no_delete BEFORE DELETE ON wallet_enrolment_events
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable wallet enrolment event'); END;
CREATE TRIGGER wallet_enrolment_events_developer_no_live BEFORE INSERT ON wallet_enrolment_events
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;

DROP TRIGGER wallet_enrolments_audit;
CREATE TRIGGER wallet_enrolments_audit AFTER UPDATE OF enrolment_revision ON wallet_provider_accounts
WHEN NEW.enrolment_revision IS NOT OLD.enrolment_revision
BEGIN
  INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
  SELECT e.created_at, e.org_id, CASE e.actor_type WHEN 'system' THEN 'system' WHEN 'api_key' THEN 'api_key' ELSE 'user' END, e.actor_id,
    'wallet_provider.enrolment_' || e.kind, 'wallet_provider_account', e.account_id, e.request_id, NULL,
    json_object('mode', e.mode, 'provider', e.provider, 'enrolment_revision', e.enrolment_revision,
      'reason', e.reason, 'actor', e.actor_type)
  FROM wallet_enrolment_events e WHERE e.account_id = NEW.id AND e.enrolment_revision = NEW.enrolment_revision;
END;

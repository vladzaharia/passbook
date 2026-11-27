-- A wallet credential event can name an API key as its actor, so a platform credential change made with a
-- Platform key is attributed to the key (and its audit row says api_key). SQLite cannot change a CHECK, so the
-- table is rebuilt as it was with one more actor type; rows, indexes and triggers are unchanged (the 0136 delete
-- rule included) and the audit trigger learns the new type, as 0181 did for enrolment events.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE _keep_wallet_credential_events AS SELECT * FROM wallet_credential_events;
DROP TABLE wallet_credential_events;
CREATE TABLE wallet_credential_events (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES wallet_credentials(id),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
  kind TEXT NOT NULL CHECK (kind IN ('create', 'rotate', 'revoke', 'verify')),
  version_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'platform', 'system', 'api_key')),
  actor_id TEXT,
  request_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (credential_id, revision),
  FOREIGN KEY (version_id, credential_id) REFERENCES wallet_credential_versions(id, credential_id),
  CHECK (kind NOT IN ('create', 'rotate') OR version_id IS NOT NULL),
  CHECK (actor_type = 'system' OR actor_id IS NOT NULL)
);
INSERT INTO wallet_credential_events SELECT * FROM _keep_wallet_credential_events;
DROP TABLE _keep_wallet_credential_events;
CREATE INDEX wallet_credential_events_version_fk ON wallet_credential_events(version_id, credential_id);

CREATE TRIGGER wallet_credential_events_no_update BEFORE UPDATE ON wallet_credential_events
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential event'); END;
CREATE TRIGGER wallet_credential_events_no_delete BEFORE DELETE ON wallet_credential_events
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = (SELECT p.org_id FROM wallet_credentials p WHERE p.id = OLD.credential_id) AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential event'); END;
CREATE TRIGGER wallet_credential_events_server_time BEFORE INSERT ON wallet_credential_events
WHEN ABS(NEW.created_at - CAST(unixepoch('subsec') * 1000 AS INTEGER)) > 5000
BEGIN SELECT RAISE(ABORT, 'wallet credential event needs the server clock'); END;

DROP TRIGGER wallet_credentials_audit;
CREATE TRIGGER wallet_credentials_audit AFTER UPDATE OF revision ON wallet_credentials
WHEN NEW.revision IS NOT OLD.revision
BEGIN
  INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
  SELECT e.created_at, NEW.org_id, CASE e.actor_type WHEN 'system' THEN 'system' WHEN 'api_key' THEN 'api_key' ELSE 'user' END, e.actor_id,
    'wallet_provider.credential_' || e.kind, 'wallet_credential', NEW.id, e.request_id, NULL,
    json_object('mode', NEW.mode, 'provider', NEW.provider, 'scope', NEW.scope, 'revision', e.revision,
      'actor', e.actor_type)
  FROM wallet_credential_events e WHERE e.credential_id = NEW.id AND e.revision = NEW.revision;
END;

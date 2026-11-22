-- Role presets no longer include scanning:admin (a credential scope is named explicitly), and a credential key needs
-- an expiry within 90 days and is never a child key. Remove the scope from unrevoked keys that break these rules:
-- keys with the org_admin role (a key cannot tell a preset scope from a named one, so a role is the marker), keys with
-- no expiry or one past 91 days from creation, and child keys. One audit row per key. Safe to re-run: a stripped key no longer matches.
INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, detail)
SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, org_id, 'system', NULL, 'api_key.scope_removed', 'api_key', id,
  json_object('scope', 'scanning:admin')
FROM api_keys
WHERE revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM json_each(api_keys.scopes) s WHERE s.value = 'scanning:admin')
  AND (EXISTS (SELECT 1 FROM json_each(api_keys.roles) r WHERE r.value = 'org_admin')
    OR expires_at IS NULL OR expires_at > created_at + 91 * 86400000
    OR parent_key_id IS NOT NULL);

-- The identity trigger forbids a scopes change: lift it for this one statement and restore it as 0039 defined it.
DROP TRIGGER IF EXISTS api_keys_identity_immutable;

UPDATE api_keys
SET scopes = (SELECT json_group_array(s.value) FROM json_each(api_keys.scopes) s WHERE s.value <> 'scanning:admin')
WHERE revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM json_each(api_keys.scopes) s WHERE s.value = 'scanning:admin')
  AND (EXISTS (SELECT 1 FROM json_each(api_keys.roles) r WHERE r.value = 'org_admin')
    OR expires_at IS NULL OR expires_at > created_at + 91 * 86400000
    OR parent_key_id IS NOT NULL);

-- A key never mints a credential scope, so no child key holds one (0155's child rules keep the rest).
CREATE TRIGGER IF NOT EXISTS api_keys_child_no_credential BEFORE INSERT ON api_keys
WHEN NEW.parent_key_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM json_each(NEW.scopes) s WHERE s.value = 'scanning:admin')
BEGIN SELECT RAISE(ABORT, 'api key child cannot hold a credential scope'); END;

CREATE TRIGGER api_keys_identity_immutable BEFORE UPDATE ON api_keys
BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id
    OR NEW.org_id IS NOT OLD.org_id
    OR NEW.name IS NOT OLD.name
    OR NEW.prefix IS NOT OLD.prefix
    OR NEW.key_hash IS NOT OLD.key_hash
    OR NEW.scopes IS NOT OLD.scopes
    OR NEW.mode IS NOT OLD.mode
    OR (NEW.created_by IS NOT OLD.created_by AND NOT (
      OLD.created_by IS NOT NULL AND NEW.created_by IS NULL
      AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.created_by)
    ))
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.expires_at IS NOT OLD.expires_at
    THEN RAISE(ABORT, 'api key identity is immutable') END;
  SELECT CASE WHEN NEW.last_used_at IS NOT OLD.last_used_at AND (
    typeof(NEW.last_used_at) != 'integer'
    OR (OLD.last_used_at IS NOT NULL AND NEW.last_used_at < OLD.last_used_at)
  ) THEN RAISE(ABORT, 'api key last use must be monotonic') END;
  SELECT CASE WHEN NEW.revoked_at IS NOT OLD.revoked_at AND (
    OLD.revoked_at IS NOT NULL OR typeof(NEW.revoked_at) != 'integer'
  ) THEN RAISE(ABORT, 'api key revocation is irreversible') END;
END;


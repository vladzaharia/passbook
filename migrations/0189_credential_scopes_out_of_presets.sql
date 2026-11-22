-- Role presets no longer include scanning:admin (a credential scope is named explicitly). Live org_admin role tokens
-- minted before that carry it in their stored scopes: remove it. A key cannot tell a preset scope from a named one, so
-- only keys with the org_admin role (the one role whose preset held it) are touched. Safe to re-run.
-- The identity trigger forbids a scopes change: lift it for this one statement and restore it as 0039 defined it.
DROP TRIGGER IF EXISTS api_keys_identity_immutable;

UPDATE api_keys
SET scopes = (SELECT json_group_array(s.value) FROM json_each(api_keys.scopes) s WHERE s.value <> 'scanning:admin')
WHERE revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM json_each(api_keys.roles) r WHERE r.value = 'org_admin')
  AND EXISTS (SELECT 1 FROM json_each(api_keys.scopes) s WHERE s.value = 'scanning:admin');

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


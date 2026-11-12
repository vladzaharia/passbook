-- A key's identity and authority are permanent; rotation creates a new key ID.
-- Deletion remains available for the org foreign-key cascade.
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

-- REPLACE evicts a key through any unique key and bypasses the identity guard above.
CREATE TRIGGER api_keys_no_replace BEFORE INSERT ON api_keys
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM api_keys WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: api_keys.id') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM api_keys WHERE prefix = NEW.prefix)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: api_keys.prefix') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM api_keys WHERE key_hash = NEW.key_hash)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: api_keys.key_hash') END;
END;

-- Key families (docs: design-api-platform 2.5): a child key minted by a key, and a key that replaces another (rotation).
-- A child never outlives its parent: grants and key resolution read the parent's live state.
ALTER TABLE api_keys ADD COLUMN parent_key_id TEXT REFERENCES api_keys (id) ON DELETE CASCADE;
-- The key this one replaced. No foreign key: the old key's row may be purged first.
ALTER TABLE api_keys ADD COLUMN rotated_from TEXT;
CREATE INDEX api_keys_parent ON api_keys (parent_key_id) WHERE parent_key_id IS NOT NULL;
CREATE INDEX api_keys_rotated_from ON api_keys (rotated_from) WHERE rotated_from IS NOT NULL;

CREATE TRIGGER api_keys_family_immutable BEFORE UPDATE OF parent_key_id, rotated_from ON api_keys
WHEN NEW.parent_key_id IS NOT OLD.parent_key_id OR NEW.rotated_from IS NOT OLD.rotated_from
BEGIN SELECT RAISE(ABORT, 'api key family is immutable'); END;

-- A child is narrower than its parent in every dimension the row can show: the same org and mode, a service key
-- that holds no scope the parent lacks (never `api-keys:write`, so one level only, nor the terminal scope), an expiry
-- no later than the parent's, and an IP list whenever the parent has one. The service also checks that each child CIDR
-- lies inside the parent's, which SQL cannot; resources are checked on insert below.
CREATE TRIGGER api_keys_child_rules BEFORE INSERT ON api_keys
WHEN NEW.parent_key_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM api_keys p
  WHERE p.id = NEW.parent_key_id AND p.parent_key_id IS NULL AND p.kind = 'service'
    AND NEW.kind = 'service' AND NEW.org_id IS NOT NULL AND p.org_id = NEW.org_id AND p.mode = NEW.mode
    AND p.revoked_at IS NULL
    AND (p.expires_at IS NULL OR (NEW.expires_at IS NOT NULL AND NEW.expires_at <= p.expires_at))
    AND (p.ip_allow IS NULL OR json_array_length(p.ip_allow) = 0
      OR (NEW.ip_allow IS NOT NULL AND json_array_length(NEW.ip_allow) > 0))
    AND (p.restricted = 0 OR NEW.restricted = 1)
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.scopes) s
      WHERE s.value IN ('api-keys:write', 'scans:write')
        OR s.value NOT IN (SELECT value FROM json_each(p.scopes)))
)
BEGIN SELECT RAISE(ABORT, 'api key child is wider than its parent'); END;

-- A restricted parent's limits carry down: a child names only what its parent names, in each kind the parent limits.
CREATE TRIGGER api_key_resources_child_rules BEFORE INSERT ON api_key_resources
WHEN EXISTS (
  SELECT 1 FROM api_keys c JOIN api_key_resources pr ON pr.key_id = c.parent_key_id AND pr.kind = NEW.kind
  WHERE c.id = NEW.key_id
) AND NOT EXISTS (
  SELECT 1 FROM api_keys c JOIN api_key_resources pr ON pr.key_id = c.parent_key_id AND pr.kind = NEW.kind
  WHERE c.id = NEW.key_id AND pr.value = NEW.value
)
BEGIN SELECT RAISE(ABORT, 'api key child is wider than its parent'); END;

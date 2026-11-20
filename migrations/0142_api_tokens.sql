-- Token kinds (docs: design-api-platform §2). Existing rows are service keys; an org-less key is a platform key.
-- The backfill runs before the triggers below exist.
ALTER TABLE api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'service' CHECK (kind IN ('service', 'personal', 'platform'));
UPDATE api_keys SET kind = 'platform' WHERE org_id IS NULL;
-- What the secret starts with, for the console list and secret scanners: `wlt` for every key made before this.
ALTER TABLE api_keys ADD COLUMN secret_label TEXT NOT NULL DEFAULT 'wlt';
-- Role presets (OrgRoleSchema): effective scopes are `scopes` plus the scopes of each role, read at request time.
ALTER TABLE api_keys ADD COLUMN roles TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(roles) AND json_type(roles) = 'array');
-- A personal key acts for one membership and dies with it.
ALTER TABLE api_keys ADD COLUMN membership_id TEXT REFERENCES org_memberships (id) ON DELETE CASCADE;
-- Set once: the key stops working at this instant (rotation overlap, scheduled retirement).
ALTER TABLE api_keys ADD COLUMN retire_at INTEGER;
-- 1 when api_key_resources narrows the key. Enforced in grants by the template-restriction work; until then such a key is refused.
ALTER TABLE api_keys ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1));
-- JSON array of CIDRs the request address must fall in; NULL means any address. Checked when the key is resolved.
ALTER TABLE api_keys ADD COLUMN ip_allow TEXT CHECK (ip_allow IS NULL OR (json_valid(ip_allow) AND json_type(ip_allow) = 'array'));
-- Volatile, set by a platform admin. NULL follows API_RATE_TIER_DEFAULT, else standard.
ALTER TABLE api_keys ADD COLUMN rate_tier TEXT CHECK (rate_tier IS NULL OR rate_tier IN ('standard', 'high', 'bulk'));
ALTER TABLE api_keys ADD COLUMN last_ip_prefix TEXT;
CREATE INDEX api_keys_membership ON api_keys (membership_id) WHERE membership_id IS NOT NULL;

CREATE TRIGGER api_keys_v2_immutable BEFORE UPDATE ON api_keys
BEGIN
  SELECT CASE WHEN NEW.kind IS NOT OLD.kind
    OR NEW.roles IS NOT OLD.roles
    OR NEW.membership_id IS NOT OLD.membership_id
    OR NEW.restricted IS NOT OLD.restricted
    OR NEW.ip_allow IS NOT OLD.ip_allow
    OR NEW.secret_label IS NOT OLD.secret_label
    THEN RAISE(ABORT, 'api key identity is immutable') END;
  SELECT CASE WHEN NEW.retire_at IS NOT OLD.retire_at AND (
    OLD.retire_at IS NOT NULL OR typeof(NEW.retire_at) != 'integer'
    OR (NEW.expires_at IS NOT NULL AND NEW.retire_at > NEW.expires_at)
  ) THEN RAISE(ABORT, 'api key retirement is set once, before expiry') END;
END;

-- What each kind must be when it is minted: a personal key names a live membership of its org and lives at most
-- 90 days (a day of client clock slack); a platform key has no org, no roles, an expiry of the same length and an IP allowlist.
CREATE TRIGGER api_keys_kind_rules BEFORE INSERT ON api_keys
WHEN (NEW.kind = 'personal' AND (NEW.membership_id IS NULL OR NEW.org_id IS NULL OR NEW.expires_at IS NULL
      OR NEW.expires_at > NEW.created_at + 7862400000
      OR NOT EXISTS (SELECT 1 FROM org_memberships m
        WHERE m.id = NEW.membership_id AND m.org_id = NEW.org_id AND m.revoked_at IS NULL)))
  OR (NEW.kind <> 'personal' AND NEW.membership_id IS NOT NULL)
  OR (NEW.kind = 'platform' AND NEW.roles <> '[]')
  OR (NEW.kind = 'platform' AND (NEW.org_id IS NOT NULL OR NEW.expires_at IS NULL
      OR NEW.expires_at > NEW.created_at + 7862400000
      OR NEW.ip_allow IS NULL OR json_array_length(NEW.ip_allow) = 0))
BEGIN SELECT RAISE(ABORT, 'api key does not fit its kind'); END;

-- Template and pass-style restrictions, written with the key and never changed (the api_key_terminals pattern).
CREATE TABLE api_key_resources (
  key_id TEXT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('template', 'pass_style')),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 100),
  PRIMARY KEY (key_id, kind, value)
) WITHOUT ROWID;
CREATE INDEX api_key_resources_value ON api_key_resources (kind, value);

CREATE TRIGGER api_key_resources_immutable BEFORE UPDATE ON api_key_resources
BEGIN SELECT RAISE(ABORT, 'api key resources are immutable'); END;

CREATE TRIGGER api_key_resources_new_key_only BEFORE INSERT ON api_key_resources
WHEN NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.id = NEW.key_id AND k.restricted = 1
    AND k.last_used_at IS NULL AND k.revoked_at IS NULL)
  OR (NEW.kind = 'template' AND NOT EXISTS (SELECT 1 FROM api_keys k JOIN templates t ON t.org_id = k.org_id
    WHERE k.id = NEW.key_id AND t.id = NEW.value))
BEGIN SELECT RAISE(ABORT, 'a restricted key names its templates and styles when minted'); END;

CREATE TRIGGER api_key_resources_no_delete BEFORE DELETE ON api_key_resources
WHEN EXISTS (SELECT 1 FROM api_keys k WHERE k.id = OLD.key_id)
BEGIN SELECT RAISE(ABORT, 'api key resources are immutable'); END;

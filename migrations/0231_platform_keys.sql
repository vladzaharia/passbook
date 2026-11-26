-- Platform keys (docs/design: platform-keys K2, K8). A platform scope belongs to a Platform key alone: kind
-- `platform`, no org, and no organization scope beside it. The mint refuses the same shapes; this is the row's own
-- guard, so a forged insert cannot hold a control-plane scope. Scopes never change after insert (0039, 0142).
CREATE TRIGGER api_keys_platform_scopes BEFORE INSERT ON api_keys
WHEN EXISTS (SELECT 1 FROM json_each(NEW.scopes) s WHERE s.value LIKE 'platform:%')
  AND (NEW.kind <> 'platform' OR NEW.org_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'platform scope on a non-platform key'); END;

CREATE TRIGGER api_keys_platform_scopes_alone BEFORE INSERT ON api_keys
WHEN EXISTS (SELECT 1 FROM json_each(NEW.scopes) s WHERE s.value LIKE 'platform:%')
  AND EXISTS (SELECT 1 FROM json_each(NEW.scopes) s WHERE s.value NOT LIKE 'platform:%')
BEGIN SELECT RAISE(ABORT, 'platform and org scopes together'); END;

-- `creator_access_revision`: see below. Added first, so the mint rules can compare it.
ALTER TABLE api_keys ADD COLUMN creator_access_revision INTEGER;

-- The mint rules of a Platform key, in the row itself so a new insert path cannot skip them: Live, made by a person in
-- a Polaris ID session (`created_amr`), a recorded creator at their current `access_revision`, and at most 31 days (30 and a day of client clock slack)
-- unless `platform:read` is its only scope. 0142 already holds the IP allowlist, no roles and 91 days.
CREATE TRIGGER api_keys_platform_key_rules BEFORE INSERT ON api_keys
WHEN EXISTS (SELECT 1 FROM json_each(NEW.scopes) s WHERE s.value LIKE 'platform:%')
  AND (NEW.mode <> 'live' OR NEW.created_by IS NULL OR NEW.created_amr IS NOT 'oidc'
    OR NEW.creator_access_revision IS NOT (SELECT access_revision FROM users WHERE id = NEW.created_by)
    OR (EXISTS (SELECT 1 FROM json_each(NEW.scopes) s WHERE s.value <> 'platform:read')
      AND (NEW.expires_at IS NULL OR NEW.expires_at > NEW.created_at + 2678400000)))
BEGIN SELECT RAISE(ABORT, 'platform key breaks its mint rules'); END;

-- Every Platform key, All-organizations ones included, records its creator's current `access_revision` (the rule above
-- only covers rows with a platform scope).
CREATE TRIGGER api_keys_platform_revision BEFORE INSERT ON api_keys
WHEN NEW.kind = 'platform'
  AND NEW.creator_access_revision IS NOT (SELECT access_revision FROM users WHERE id = NEW.created_by)
BEGIN SELECT RAISE(ABORT, 'platform key breaks its mint rules'); END;

-- A key made by an admin lives only while that admin does. `creator_access_revision` is the creator's
-- `users.access_revision` at mint (null on every other key): the key is live only while it is still the same, so
-- a disable and re-enable, or the removal of the admin role, ends it for good. Set once.
CREATE TRIGGER api_keys_creator_revision_immutable BEFORE UPDATE OF creator_access_revision ON api_keys
WHEN NEW.creator_access_revision IS NOT OLD.creator_access_revision
BEGIN SELECT RAISE(ABORT, 'api key identity is immutable'); END;

-- Signing in without the admin role (`last_roles` is rewritten at every sign-in) is the removal of it.
CREATE TRIGGER users_admin_removed AFTER UPDATE OF last_roles ON users
WHEN json_valid(OLD.last_roles) AND EXISTS (SELECT 1 FROM json_each(OLD.last_roles) r WHERE r.value = 'admin')
  AND NOT (json_valid(NEW.last_roles) AND EXISTS (SELECT 1 FROM json_each(NEW.last_roles) r WHERE r.value = 'admin'))
BEGIN UPDATE users SET access_revision = access_revision + 1 WHERE rowid = NEW.rowid; END;

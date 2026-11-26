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

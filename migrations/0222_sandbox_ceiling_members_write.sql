-- members:write joined the credential scopes a developer sandbox never holds (SANDBOX_KEY_SCOPES leaves it out).
-- 0192's trigger lists the scopes left out; this recreates it with the full list. tools/sandbox-ceiling.test.ts
-- compares the latest list with MINTABLE_SCOPES minus SANDBOX_KEY_SCOPES.
DROP TRIGGER api_keys_developer_scope_ceiling;
CREATE TRIGGER api_keys_developer_scope_ceiling BEFORE INSERT ON api_keys
WHEN EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
 AND EXISTS (SELECT 1 FROM json_each(NEW.scopes) s
             WHERE s.value IN ('api-keys:write', 'members:write', 'scans:write', 'scanning:admin', 'nfc:keys'))
BEGIN SELECT RAISE(ABORT, 'a developer org key holds the sandbox ceiling'); END;

-- Sandbox keys made before members:write was left out: end them, at the moment they were made, so the migration
-- is the same wherever it runs.
UPDATE api_keys
SET revoked_at = created_at
WHERE revoked_at IS NULL
  AND org_id IN (SELECT id FROM orgs WHERE kind = 'developer')
  AND EXISTS (SELECT 1 FROM json_each(api_keys.scopes) s WHERE s.value = 'members:write');

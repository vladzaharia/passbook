-- A developer org's key holds the sandbox ceiling (SANDBOX_KEY_SCOPES): never key minting, a terminal's scope or
-- scanning setup. The service checks it at mint and rotation; this is the second line (rotation is an INSERT too).
-- The list below is MINTABLE_SCOPES minus SANDBOX_KEY_SCOPES; tools/sandbox-ceiling.test.ts compares them.
CREATE TRIGGER api_keys_developer_scope_ceiling BEFORE INSERT ON api_keys
WHEN EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
 AND EXISTS (SELECT 1 FROM json_each(NEW.scopes) s
             WHERE s.value IN ('api-keys:write', 'scans:write', 'scanning:admin'))
BEGIN SELECT RAISE(ABORT, 'a developer org key holds the sandbox ceiling'); END;

-- Keys made before the ceiling held: end them. Their owners make new ones.
UPDATE api_keys
SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE revoked_at IS NULL
  AND org_id IN (SELECT id FROM orgs WHERE kind = 'developer')
  AND EXISTS (SELECT 1 FROM json_each(api_keys.scopes) s
              WHERE s.value IN ('api-keys:write', 'scans:write', 'scanning:admin'));

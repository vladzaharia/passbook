-- The web logo and mark level live in orgs.branding but never reach a wallet pass. Dirtying every
-- provider instance for them would resync the org's whole fleet when someone swaps a page logo.
DROP TRIGGER wallet_provider_dirty_org;
CREATE TRIGGER wallet_provider_dirty_org AFTER UPDATE OF status, branding ON orgs
WHEN OLD.status IS NOT NEW.status
  OR json_remove(OLD.branding, '$.web', '$.mark') IS NOT json_remove(NEW.branding, '$.web', '$.mark')
BEGIN
  INSERT INTO wallet_provider_instance_dirty(instance_id, generation)
  SELECT id, 1 FROM wallet_provider_instances WHERE org_id = NEW.id
  ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0;
END;

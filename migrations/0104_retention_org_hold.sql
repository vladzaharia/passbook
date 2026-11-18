-- An org on legal hold cannot be soft-deleted: the check is atomic with the status change.
CREATE TRIGGER orgs_hold_blocks_delete BEFORE UPDATE OF status ON orgs
WHEN NEW.status = 'deleted' AND OLD.status != 'deleted'
  AND EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = OLD.id AND h.released_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'org is on legal hold');
END;

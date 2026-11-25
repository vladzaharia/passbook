-- A role change retires the membership and writes its successor in one batch (org.member.roles). The
-- member's scheduled broadcasts belong to the person, not the row: they stay scheduled, and a send
-- re-checks the creator against the successor, which keeps the member's created_at. Any other revoke
-- still cancels them.
DROP TRIGGER memberships_revoke_cancels_broadcasts;
CREATE TRIGGER memberships_revoke_cancels_broadcasts AFTER UPDATE OF revoked_at ON org_memberships
WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM authority_grants g WHERE g.purpose = 'org.member.roles' AND g.target_id = NEW.id)
BEGIN
  UPDATE broadcasts SET state = 'cancelled', error_code = 'CREATOR_REVOKED',
    finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE created_by_type = 'user' AND created_by_id = NEW.user_id AND org_id = NEW.org_id
    AND state = 'scheduled';
END;

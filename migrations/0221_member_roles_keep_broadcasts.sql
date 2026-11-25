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

-- joined_at is when the person joined; created_at is when this membership row was written. They differ
-- only after a role change, whose successor row keeps joined_at. Approvals compare created_at (a promotion
-- voids an earlier sole approval); a broadcast's creator is judged by joined_at.
ALTER TABLE org_memberships ADD COLUMN joined_at INTEGER;
DROP TRIGGER org_memberships_immutable;
UPDATE org_memberships SET joined_at = created_at;
-- Revoking is the only change a row takes, plus the one fill of joined_at below.
CREATE TRIGGER org_memberships_immutable BEFORE UPDATE ON org_memberships
WHEN NOT (OLD.joined_at IS NULL AND NEW.joined_at IS OLD.created_at AND NEW.revoked_at IS OLD.revoked_at
    AND NEW.id IS OLD.id AND NEW.org_id IS OLD.org_id AND NEW.user_id IS OLD.user_id
    AND NEW.invitation_id IS OLD.invitation_id AND NEW.roles IS OLD.roles AND NEW.created_at IS OLD.created_at)
  AND (NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.user_id IS NOT OLD.user_id
    OR NEW.invitation_id IS NOT OLD.invitation_id OR NEW.roles IS NOT OLD.roles OR NEW.created_at IS NOT OLD.created_at
    OR (NEW.joined_at IS NOT OLD.joined_at AND OLD.joined_at IS NOT NULL)
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'immutable membership'); END;
CREATE TRIGGER org_memberships_joined AFTER INSERT ON org_memberships
WHEN NEW.joined_at IS NULL
BEGIN UPDATE org_memberships SET joined_at = NEW.created_at WHERE id = NEW.id; END;

-- Personal organizations: one per platform administrator, marked by the user it belongs to.
-- The marker is set at insert and never changes. A closed personal org keeps it, so it is not recreated.
ALTER TABLE orgs ADD COLUMN personal_user_id TEXT REFERENCES users (id);
CREATE UNIQUE INDEX orgs_personal_user ON orgs (personal_user_id) WHERE personal_user_id IS NOT NULL;
CREATE TRIGGER orgs_personal_fixed BEFORE UPDATE OF personal_user_id ON orgs
WHEN NEW.personal_user_id IS NOT OLD.personal_user_id
BEGIN SELECT RAISE(ABORT, 'orgs personal marker is immutable'); END;
-- A personal org has one member, its owner, forever: no other membership, and no invitation except the
-- owner's own already-accepted one made with the org.
CREATE TRIGGER org_memberships_personal_single BEFORE INSERT ON org_memberships
WHEN EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.personal_user_id IS NOT NULL AND o.personal_user_id IS NOT NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'personal org has one member'); END;
CREATE TRIGGER org_invitations_personal_single BEFORE INSERT ON org_invitations
WHEN EXISTS (
  SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.personal_user_id IS NOT NULL
    AND (NEW.accepted_at IS NULL
      OR NEW.email IS NOT (SELECT u.primary_email FROM users u WHERE u.id = o.personal_user_id)))
BEGIN SELECT RAISE(ABORT, 'personal org has one member'); END;

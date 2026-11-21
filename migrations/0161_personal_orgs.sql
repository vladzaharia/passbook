-- Personal organizations: one per platform administrator, marked by the user it belongs to.
-- The marker is set at insert and never changes. A closed personal org keeps it, so it is not recreated.
ALTER TABLE orgs ADD COLUMN personal_user_id TEXT REFERENCES users (id);
CREATE UNIQUE INDEX orgs_personal_user ON orgs (personal_user_id) WHERE personal_user_id IS NOT NULL;
CREATE TRIGGER orgs_personal_fixed BEFORE UPDATE OF personal_user_id ON orgs
WHEN NEW.personal_user_id IS NOT OLD.personal_user_id
BEGIN SELECT RAISE(ABORT, 'orgs personal marker is immutable'); END;

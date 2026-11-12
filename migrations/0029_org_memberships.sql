-- Memberships and invitations are append-only history; revocation and acceptance cannot be undone.
CREATE TABLE org_memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  invitation_id TEXT NOT NULL REFERENCES org_invitations(id),
  roles TEXT NOT NULL CHECK (json_valid(roles) AND json_type(roles) = 'array' AND json_array_length(roles) > 0),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX org_memberships_active ON org_memberships(org_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX org_memberships_org ON org_memberships(org_id);
CREATE UNIQUE INDEX org_memberships_invitation ON org_memberships(invitation_id);
CREATE INDEX org_memberships_user ON org_memberships(user_id);
CREATE TABLE org_invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL,
  roles TEXT NOT NULL CHECK (json_valid(roles) AND json_type(roles) = 'array' AND json_array_length(roles) > 0),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  accepted_at INTEGER,
  CHECK (revoked_at IS NULL OR accepted_at IS NULL)
);
CREATE INDEX org_invitations_org ON org_invitations(org_id);
CREATE TRIGGER org_memberships_immutable BEFORE UPDATE ON org_memberships
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.invitation_id IS NOT OLD.invitation_id OR NEW.roles IS NOT OLD.roles OR NEW.created_at IS NOT OLD.created_at
  OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT, 'immutable membership'); END;
CREATE TRIGGER org_memberships_no_delete BEFORE DELETE ON org_memberships
BEGIN SELECT RAISE(ABORT, 'immutable membership'); END;
CREATE TRIGGER org_invitations_immutable BEFORE UPDATE ON org_invitations
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.email IS NOT OLD.email
  OR NEW.roles IS NOT OLD.roles OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.revoked_at IS NOT NULL OR OLD.accepted_at IS NOT NULL
  OR (NEW.revoked_at IS NULL AND NEW.accepted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'immutable invitation'); END;
CREATE TRIGGER org_invitations_no_delete BEFORE DELETE ON org_invitations
BEGIN SELECT RAISE(ABORT, 'immutable invitation'); END;

-- Authority epochs (authority-epochs.md section 1.1). access_revision moves only with org status.
ALTER TABLE orgs ADD COLUMN access_revision INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER orgs_access_revision AFTER UPDATE OF status ON orgs
WHEN NEW.status IS NOT OLD.status AND NEW.access_revision = OLD.access_revision
BEGIN UPDATE orgs SET access_revision = access_revision + 1 WHERE rowid = NEW.rowid; END;
CREATE TRIGGER orgs_access_revision_monotonic BEFORE UPDATE OF access_revision ON orgs
WHEN NEW.access_revision < OLD.access_revision
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;

-- Role names are checked once at insert; the rows are immutable afterwards.
CREATE TRIGGER org_memberships_roles_valid BEFORE INSERT ON org_memberships
WHEN json_type(NEW.roles) IS NOT 'array'
  OR EXISTS (SELECT 1 FROM json_each(NEW.roles) r WHERE r.type != 'text' OR r.value NOT IN ('org_admin','integration_admin','template_author','template_reviewer','template_publisher','pass_operator','read_only'))
  OR (SELECT count(*) FROM json_each(NEW.roles)) != (SELECT count(DISTINCT value) FROM json_each(NEW.roles))
BEGIN SELECT RAISE(ABORT, 'invalid role names'); END;
CREATE TRIGGER org_invitations_roles_valid BEFORE INSERT ON org_invitations
WHEN json_type(NEW.roles) IS NOT 'array'
  OR EXISTS (SELECT 1 FROM json_each(NEW.roles) r WHERE r.type != 'text' OR r.value NOT IN ('org_admin','integration_admin','template_author','template_reviewer','template_publisher','pass_operator','read_only'))
  OR (SELECT count(*) FROM json_each(NEW.roles)) != (SELECT count(DISTINCT value) FROM json_each(NEW.roles))
BEGIN SELECT RAISE(ABORT, 'invalid role names'); END;

-- REPLACE evicts a row through any unique key and bypasses the update guards.
CREATE TRIGGER org_memberships_no_replace BEFORE INSERT ON org_memberships
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM org_memberships WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: org_memberships.id') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM org_memberships WHERE invitation_id = NEW.invitation_id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: org_memberships.invitation_id') END;
  SELECT CASE WHEN NEW.revoked_at IS NULL AND EXISTS (SELECT 1 FROM org_memberships
      WHERE org_id = NEW.org_id AND user_id = NEW.user_id AND revoked_at IS NULL)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: org_memberships.org_id, org_memberships.user_id') END;
END;
CREATE TRIGGER org_invitations_no_replace BEFORE INSERT ON org_invitations
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM org_invitations WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: org_invitations.id') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM org_invitations WHERE token_hash = NEW.token_hash)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: org_invitations.token_hash') END;
END;

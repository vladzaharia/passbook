-- Developer invitations (dev-invite-design.md 3.7): an org vouches for a person who gets the Polaris ID developers group.
-- Rows are append-only history: identity columns never change, each end state is set once, and only an org purge deletes (as 0136).
CREATE TABLE developer_invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  org_invitation_id TEXT UNIQUE REFERENCES org_invitations(id),
  created_by_user TEXT REFERENCES users(id),
  created_by_key TEXT REFERENCES api_keys(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claim_until INTEGER NOT NULL CHECK (claim_until >= expires_at),
  revoked_at INTEGER,
  accepted_at INTEGER,
  accepted_user_id TEXT REFERENCES users(id),
  swept_at INTEGER,
  CHECK ((created_by_user IS NULL) <> (created_by_key IS NULL)),
  CHECK (revoked_at IS NULL OR accepted_at IS NULL),
  CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL))
);
CREATE INDEX developer_invitations_org ON developer_invitations(org_id, created_at);
CREATE INDEX developer_invitations_open ON developer_invitations(claim_until)
  WHERE accepted_at IS NULL AND swept_at IS NULL;

-- One row per Pocket ID signup token minted for an invitation: the token id, never the token.
CREATE TABLE developer_invite_setups (
  idp_token_id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES developer_invitations(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX developer_invite_setups_invitation ON developer_invite_setups(invitation_id);

CREATE TABLE developer_sponsors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  invitation_id TEXT NOT NULL UNIQUE REFERENCES developer_invitations(id),
  idp_subject TEXT NOT NULL,
  group_source TEXT NOT NULL CHECK (group_source IN ('signup', 'added', 'existing')),
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT CHECK (end_reason IN ('removed', 'org_closed')),
  settled_at INTEGER,
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (settled_at IS NULL OR (ended_at IS NOT NULL AND settled_at >= ended_at))
);
CREATE UNIQUE INDEX developer_sponsors_live ON developer_sponsors(org_id, user_id) WHERE ended_at IS NULL;
CREATE INDEX developer_sponsors_user ON developer_sponsors(user_id);
CREATE INDEX developer_sponsors_unsettled ON developer_sponsors(ended_at)
  WHERE ended_at IS NOT NULL AND settled_at IS NULL;

CREATE TRIGGER developer_invitations_immutable BEFORE UPDATE ON developer_invitations
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.email IS NOT OLD.email
  OR NEW.token_hash IS NOT OLD.token_hash OR NEW.org_invitation_id IS NOT OLD.org_invitation_id
  OR NEW.created_by_user IS NOT OLD.created_by_user OR NEW.created_by_key IS NOT OLD.created_by_key
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.claim_until < OLD.claim_until
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
  OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS NOT OLD.accepted_at)
  OR (OLD.accepted_user_id IS NOT NULL AND NEW.accepted_user_id IS NOT OLD.accepted_user_id)
  OR (OLD.swept_at IS NOT NULL AND NEW.swept_at IS NOT OLD.swept_at)
BEGIN SELECT RAISE(ABORT, 'immutable developer invitation'); END;
CREATE TRIGGER developer_invitations_no_delete BEFORE DELETE ON developer_invitations
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable developer invitation'); END;

-- A setup is minted at most three times per invitation; a new link replaces the previous one at Pocket ID, not here.
CREATE TRIGGER developer_invite_setups_cap BEFORE INSERT ON developer_invite_setups
WHEN (SELECT count(*) FROM developer_invite_setups WHERE invitation_id = NEW.invitation_id) >= 3
BEGIN SELECT RAISE(ABORT, 'developer setup cap'); END;
CREATE TRIGGER developer_invite_setups_immutable BEFORE UPDATE ON developer_invite_setups
BEGIN SELECT RAISE(ABORT, 'immutable developer setup'); END;
CREATE TRIGGER developer_invite_setups_no_delete BEFORE DELETE ON developer_invite_setups
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = (SELECT i.org_id FROM developer_invitations i WHERE i.id = OLD.invitation_id) AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable developer setup'); END;

CREATE TRIGGER developer_sponsors_immutable BEFORE UPDATE ON developer_sponsors
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.invitation_id IS NOT OLD.invitation_id OR NEW.idp_subject IS NOT OLD.idp_subject
  OR NEW.group_source IS NOT OLD.group_source OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.ended_at IS NOT NULL AND (NEW.ended_at IS NOT OLD.ended_at OR NEW.end_reason IS NOT OLD.end_reason))
  OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS NOT OLD.settled_at)
BEGIN SELECT RAISE(ABORT, 'immutable developer sponsor'); END;
CREATE TRIGGER developer_sponsors_no_delete BEFORE DELETE ON developer_sponsors
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable developer sponsor'); END;

-- REPLACE evicts a row through any unique key and bypasses the update guards.
CREATE TRIGGER developer_invitations_no_replace BEFORE INSERT ON developer_invitations
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM developer_invitations WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: developer_invitations.id') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM developer_invitations WHERE token_hash = NEW.token_hash)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: developer_invitations.token_hash') END;
  SELECT CASE WHEN NEW.org_invitation_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM developer_invitations WHERE org_invitation_id = NEW.org_invitation_id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: developer_invitations.org_invitation_id') END;
END;
CREATE TRIGGER developer_invite_setups_no_replace BEFORE INSERT ON developer_invite_setups
WHEN EXISTS (SELECT 1 FROM developer_invite_setups WHERE idp_token_id = NEW.idp_token_id)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: developer_invite_setups.idp_token_id'); END;
CREATE TRIGGER developer_sponsors_no_replace BEFORE INSERT ON developer_sponsors
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM developer_sponsors WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: developer_sponsors.id') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM developer_sponsors WHERE invitation_id = NEW.invitation_id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: developer_sponsors.invitation_id') END;
  SELECT CASE WHEN NEW.ended_at IS NULL AND EXISTS (SELECT 1 FROM developer_sponsors
      WHERE org_id = NEW.org_id AND user_id = NEW.user_id AND ended_at IS NULL)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: developer_sponsors.org_id, developer_sponsors.user_id') END;
END;

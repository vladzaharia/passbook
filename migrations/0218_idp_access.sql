-- Polaris ID access (pocketid-binding-design.md 3.2 and 6, design 2 section 6): what each Polaris ID subject
-- should hold, what was observed, and the queue between them. Deterministic: triggers take times from the rows
-- they fire on, never from `now`. Rows that record a decision are append-only history, as 0214.
-- A target is a writable role (`console`, `developer`, `support`) or `g:<key>`, a custom or adopted group.

-- Platform admins grant developer or support directly (no org). Rows are history: revoke, never delete.
CREATE TABLE platform_role_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('developer', 'support')),
  granted_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT REFERENCES users(id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX platform_role_grants_live ON platform_role_grants(user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX platform_role_grants_user ON platform_role_grants(user_id);

-- Custom and adopted groups PassBook asked for (the binding holds the Polaris ID ids). A key is never reused.
CREATE TABLE idp_groups (
  key TEXT PRIMARY KEY CHECK (key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9_]*' AND length(key) BETWEEN 2 AND 40
    AND key NOT IN ('console', 'developer', 'support', 'platform_admin', 'users')),
  kind TEXT NOT NULL CHECK (kind IN ('custom', 'adopted')),
  friendly_name TEXT NOT NULL CHECK (length(friendly_name) BETWEEN 2 AND 50),
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- Org rule: members of one org (optionally only some org roles) belong to the group while the rule is live.
CREATE TABLE idp_group_rules (
  id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL REFERENCES idp_groups(key),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  org_roles TEXT CHECK (org_roles IS NULL OR (json_valid(org_roles) AND json_type(org_roles) = 'array' AND json_array_length(org_roles) > 0)),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_by TEXT REFERENCES users(id),
  CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);
CREATE UNIQUE INDEX idp_group_rules_live ON idp_group_rules(group_key, org_id) WHERE ended_at IS NULL;
CREATE INDEX idp_group_rules_org ON idp_group_rules(org_id) WHERE ended_at IS NULL;

-- Platform invitation: a person gets custom or adopted groups (and optionally developer) without an org.
CREATE TABLE platform_invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  groups TEXT NOT NULL CHECK (json_valid(groups) AND json_type(groups) = 'array' AND json_array_length(groups) BETWEEN 0 AND 5),
  developer INTEGER NOT NULL CHECK (developer IN (0, 1)),
  created_by_user TEXT REFERENCES users(id),
  created_by_key TEXT REFERENCES api_keys(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claim_until INTEGER NOT NULL CHECK (claim_until >= expires_at),
  revoked_at INTEGER,
  accepted_at INTEGER,
  accepted_subject TEXT,
  swept_at INTEGER,
  CHECK ((created_by_user IS NULL) <> (created_by_key IS NULL)),
  CHECK (developer = 1 OR json_array_length(groups) > 0),
  CHECK (revoked_at IS NULL OR accepted_at IS NULL),
  CHECK ((accepted_at IS NULL) = (accepted_subject IS NULL))
);
CREATE INDEX platform_invitations_open ON platform_invitations(claim_until)
  WHERE accepted_at IS NULL AND swept_at IS NULL;

CREATE TABLE platform_invitation_setups (
  idp_token_id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES platform_invitations(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX platform_invitation_setups_invitation ON platform_invitation_setups(invitation_id);

-- Manual members, and platform invitations once accepted. Keyed by subject: the person may have no PassBook user.
CREATE TABLE idp_group_members (
  id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL REFERENCES idp_groups(key),
  subject TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN ('manual', 'invitation')),
  platform_invitation_id TEXT REFERENCES platform_invitations(id),
  added_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  removed_at INTEGER,
  removed_by TEXT REFERENCES users(id),
  CHECK ((source = 'invitation') = (platform_invitation_id IS NOT NULL))
);
CREATE UNIQUE INDEX idp_group_members_live ON idp_group_members(group_key, subject) WHERE removed_at IS NULL;
CREATE INDEX idp_group_members_subject ON idp_group_members(subject) WHERE removed_at IS NULL;

-- Member invitation setups (developer ones live in 0214, platform ones above): at most 3 per invitation.
CREATE TABLE org_invitation_setups (
  idp_token_id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES org_invitations(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX org_invitation_setups_invitation ON org_invitation_setups(invitation_id);

-- Existing-account claims: the mailbox proved, the subject found, a provisional target until claim_until.
-- `swept_at` is set once, when the sweep has settled a claim that ended unaccepted.
CREATE TABLE idp_invite_claims (
  id TEXT PRIMARY KEY,
  org_invitation_id TEXT REFERENCES org_invitations(id),
  developer_invitation_id TEXT REFERENCES developer_invitations(id),
  platform_invitation_id TEXT REFERENCES platform_invitations(id),
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  claim_until INTEGER NOT NULL CHECK (claim_until > created_at),
  swept_at INTEGER,
  CHECK ((org_invitation_id IS NOT NULL) + (developer_invitation_id IS NOT NULL) + (platform_invitation_id IS NOT NULL) = 1)
);
CREATE UNIQUE INDEX idp_invite_claims_org ON idp_invite_claims(org_invitation_id, subject) WHERE org_invitation_id IS NOT NULL;
CREATE UNIQUE INDEX idp_invite_claims_developer ON idp_invite_claims(developer_invitation_id, subject) WHERE developer_invitation_id IS NOT NULL;
CREATE UNIQUE INDEX idp_invite_claims_platform ON idp_invite_claims(platform_invitation_id, subject) WHERE platform_invitation_id IS NOT NULL;
CREATE INDEX idp_invite_claims_subject ON idp_invite_claims(subject);
CREATE INDEX idp_invite_claims_open ON idp_invite_claims(claim_until) WHERE swept_at IS NULL;

-- Projection cache per subject and target. The binding's idp_grants is the record of what PassBook added.
CREATE TABLE idp_target_state (
  subject TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('console', 'developer', 'support')
    OR (target GLOB 'g:[a-z]*' AND substr(target, 3) NOT GLOB '*[^a-z0-9_]*' AND length(target) BETWEEN 4 AND 42)),
  user_id TEXT REFERENCES users(id),
  observed INTEGER CHECK (observed IN (0, 1)),
  presence TEXT NOT NULL DEFAULT 'none' CHECK (presence IN ('none', 'passbook', 'external')),
  held_at INTEGER,
  applied_at INTEGER,
  observed_at INTEGER,
  error_code TEXT,
  PRIMARY KEY (subject, target)
);
CREATE INDEX idp_target_state_user ON idp_target_state(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idp_target_state_held ON idp_target_state(target) WHERE held_at IS NOT NULL;

-- The drain queue. `version` moves with every mark, so a drain clears only the mark it read.
CREATE TABLE idp_dirty (
  subject TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idp_dirty_due ON idp_dirty(next_at);

CREATE TABLE idp_drift (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  subject TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('console', 'developer', 'support')
    OR (target GLOB 'g:[a-z]*' AND substr(target, 3) NOT GLOB '*[^a-z0-9_]*' AND length(target) BETWEEN 4 AND 42)),
  kind TEXT NOT NULL CHECK (kind IN ('missing', 'unexpected', 'external_added', 'owner_removed',
    'disabled_in_idp', 'admin_changed', 'unknown_member', 'apply_failed')),
  found_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT,
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
CREATE INDEX idp_drift_open ON idp_drift(found_at) WHERE resolved_at IS NULL;
CREATE INDEX idp_drift_subject ON idp_drift(subject, target) WHERE resolved_at IS NULL;
CREATE INDEX idp_drift_run ON idp_drift(run_id);

-- SCIM mirror (PB-5): opaque ids and flags only.
CREATE TABLE idp_directory_users (
  scim_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  last_modified INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE idp_directory_groups (
  scim_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE,
  members TEXT NOT NULL CHECK (json_valid(members)),
  last_modified INTEGER NOT NULL,
  deleted_at INTEGER
);

-- ---------------------------------------------------------------------------------------------------------
-- Append-only history: identity columns never change, each end state is set once, nothing is replaced.

CREATE TRIGGER platform_role_grants_immutable BEFORE UPDATE ON platform_role_grants
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.role IS NOT OLD.role
  OR NEW.granted_by IS NOT OLD.granted_by OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revoked_by IS NOT OLD.revoked_by))
BEGIN SELECT RAISE(ABORT, 'immutable platform role grant'); END;
CREATE TRIGGER platform_role_grants_no_delete BEFORE DELETE ON platform_role_grants
BEGIN SELECT RAISE(ABORT, 'immutable platform role grant'); END;
CREATE TRIGGER platform_role_grants_no_replace BEFORE INSERT ON platform_role_grants
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM platform_role_grants WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: platform_role_grants.id') END;
  SELECT CASE WHEN NEW.revoked_at IS NULL AND EXISTS (SELECT 1 FROM platform_role_grants
      WHERE user_id = NEW.user_id AND role = NEW.role AND revoked_at IS NULL)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: platform_role_grants.user_id, platform_role_grants.role') END;
END;

CREATE TRIGGER idp_groups_immutable BEFORE UPDATE ON idp_groups
WHEN NEW.key IS NOT OLD.key OR NEW.kind IS NOT OLD.kind OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.deleted_at IS NOT NULL AND (NEW.deleted_at IS NOT OLD.deleted_at OR NEW.friendly_name IS NOT OLD.friendly_name))
BEGIN SELECT RAISE(ABORT, 'immutable group'); END;
CREATE TRIGGER idp_groups_no_delete BEFORE DELETE ON idp_groups
BEGIN SELECT RAISE(ABORT, 'immutable group'); END;
CREATE TRIGGER idp_groups_no_replace BEFORE INSERT ON idp_groups
WHEN EXISTS (SELECT 1 FROM idp_groups WHERE key = NEW.key)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: idp_groups.key'); END;

-- A rule needs a live group and an org that is neither personal nor a developer sandbox; at most 5 live per group;
-- role names are checked once at insert (as org_memberships).
CREATE TRIGGER idp_group_rules_valid BEFORE INSERT ON idp_group_rules
WHEN NOT EXISTS (SELECT 1 FROM idp_groups g WHERE g.key = NEW.group_key AND g.deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND (o.personal_user_id IS NOT NULL OR o.kind IS NOT 'standard'))
  OR (SELECT count(*) FROM idp_group_rules WHERE group_key = NEW.group_key AND ended_at IS NULL) >= 5
  OR (NEW.org_roles IS NOT NULL AND (
    EXISTS (SELECT 1 FROM json_each(NEW.org_roles) r WHERE r.type != 'text' OR r.value NOT IN ('org_admin','integration_admin','template_author','template_reviewer','template_publisher','pass_operator','read_only'))
    OR (SELECT count(*) FROM json_each(NEW.org_roles)) != (SELECT count(DISTINCT value) FROM json_each(NEW.org_roles))))
BEGIN SELECT RAISE(ABORT, 'invalid group rule'); END;
CREATE TRIGGER idp_group_rules_immutable BEFORE UPDATE ON idp_group_rules
WHEN NEW.id IS NOT OLD.id OR NEW.group_key IS NOT OLD.group_key OR NEW.org_id IS NOT OLD.org_id
  OR NEW.org_roles IS NOT OLD.org_roles OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.ended_at IS NOT NULL AND (NEW.ended_at IS NOT OLD.ended_at OR NEW.ended_by IS NOT OLD.ended_by))
BEGIN SELECT RAISE(ABORT, 'immutable group rule'); END;
CREATE TRIGGER idp_group_rules_no_delete BEFORE DELETE ON idp_group_rules
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable group rule'); END;
CREATE TRIGGER idp_group_rules_no_replace BEFORE INSERT ON idp_group_rules
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM idp_group_rules WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: idp_group_rules.id') END;
  SELECT CASE WHEN NEW.ended_at IS NULL AND EXISTS (SELECT 1 FROM idp_group_rules
      WHERE group_key = NEW.group_key AND org_id = NEW.org_id AND ended_at IS NULL)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: idp_group_rules.group_key, idp_group_rules.org_id') END;
END;

CREATE TRIGGER idp_group_members_valid BEFORE INSERT ON idp_group_members
WHEN NOT EXISTS (SELECT 1 FROM idp_groups g WHERE g.key = NEW.group_key AND g.deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid group member'); END;
CREATE TRIGGER idp_group_members_immutable BEFORE UPDATE ON idp_group_members
WHEN NEW.id IS NOT OLD.id OR NEW.group_key IS NOT OLD.group_key OR NEW.subject IS NOT OLD.subject
  OR NEW.user_id IS NOT OLD.user_id OR NEW.source IS NOT OLD.source
  OR NEW.platform_invitation_id IS NOT OLD.platform_invitation_id OR NEW.added_by IS NOT OLD.added_by
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.removed_at IS NOT NULL AND (NEW.removed_at IS NOT OLD.removed_at OR NEW.removed_by IS NOT OLD.removed_by))
BEGIN SELECT RAISE(ABORT, 'immutable group member'); END;
CREATE TRIGGER idp_group_members_no_delete BEFORE DELETE ON idp_group_members
BEGIN SELECT RAISE(ABORT, 'immutable group member'); END;
CREATE TRIGGER idp_group_members_no_replace BEFORE INSERT ON idp_group_members
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM idp_group_members WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: idp_group_members.id') END;
  SELECT CASE WHEN NEW.removed_at IS NULL AND EXISTS (SELECT 1 FROM idp_group_members
      WHERE group_key = NEW.group_key AND subject = NEW.subject AND removed_at IS NULL)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: idp_group_members.group_key, idp_group_members.subject') END;
END;

-- Group keys of a platform invitation: text, distinct, each a live group.
CREATE TRIGGER platform_invitations_valid BEFORE INSERT ON platform_invitations
WHEN EXISTS (SELECT 1 FROM json_each(NEW.groups) j WHERE j.type != 'text'
    OR NOT EXISTS (SELECT 1 FROM idp_groups g WHERE g.key = j.value AND g.deleted_at IS NULL))
  OR (SELECT count(*) FROM json_each(NEW.groups)) != (SELECT count(DISTINCT value) FROM json_each(NEW.groups))
BEGIN SELECT RAISE(ABORT, 'invalid platform invitation groups'); END;
CREATE TRIGGER platform_invitations_immutable BEFORE UPDATE ON platform_invitations
WHEN NEW.id IS NOT OLD.id OR NEW.email IS NOT OLD.email OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.groups IS NOT OLD.groups OR NEW.developer IS NOT OLD.developer
  OR NEW.created_by_user IS NOT OLD.created_by_user OR NEW.created_by_key IS NOT OLD.created_by_key
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.claim_until < OLD.claim_until
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
  OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS NOT OLD.accepted_at)
  OR (OLD.accepted_subject IS NOT NULL AND NEW.accepted_subject IS NOT OLD.accepted_subject)
  OR (OLD.swept_at IS NOT NULL AND NEW.swept_at IS NOT OLD.swept_at)
BEGIN SELECT RAISE(ABORT, 'immutable platform invitation'); END;
CREATE TRIGGER platform_invitations_no_delete BEFORE DELETE ON platform_invitations
BEGIN SELECT RAISE(ABORT, 'immutable platform invitation'); END;
CREATE TRIGGER platform_invitations_no_replace BEFORE INSERT ON platform_invitations
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM platform_invitations WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: platform_invitations.id') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM platform_invitations WHERE token_hash = NEW.token_hash)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: platform_invitations.token_hash') END;
END;

-- Setups: at most three per invitation, none on an invitation that ended, immutable, gone only with the org.
CREATE TRIGGER platform_invitation_setups_cap BEFORE INSERT ON platform_invitation_setups
WHEN (SELECT count(*) FROM platform_invitation_setups WHERE invitation_id = NEW.invitation_id) >= 3
  OR EXISTS (SELECT 1 FROM platform_invitations i WHERE i.id = NEW.invitation_id AND (i.revoked_at IS NOT NULL OR i.accepted_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'platform setup refused'); END;
CREATE TRIGGER platform_invitation_setups_immutable BEFORE UPDATE ON platform_invitation_setups
BEGIN SELECT RAISE(ABORT, 'immutable platform setup'); END;
CREATE TRIGGER platform_invitation_setups_no_delete BEFORE DELETE ON platform_invitation_setups
BEGIN SELECT RAISE(ABORT, 'immutable platform setup'); END;
CREATE TRIGGER platform_invitation_setups_no_replace BEFORE INSERT ON platform_invitation_setups
WHEN EXISTS (SELECT 1 FROM platform_invitation_setups WHERE idp_token_id = NEW.idp_token_id)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: platform_invitation_setups.idp_token_id'); END;

CREATE TRIGGER org_invitation_setups_cap BEFORE INSERT ON org_invitation_setups
WHEN (SELECT count(*) FROM org_invitation_setups WHERE invitation_id = NEW.invitation_id) >= 3
  OR EXISTS (SELECT 1 FROM org_invitations i WHERE i.id = NEW.invitation_id AND (i.revoked_at IS NOT NULL OR i.accepted_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'org setup refused'); END;
CREATE TRIGGER org_invitation_setups_immutable BEFORE UPDATE ON org_invitation_setups
BEGIN SELECT RAISE(ABORT, 'immutable org setup'); END;
CREATE TRIGGER org_invitation_setups_no_delete BEFORE DELETE ON org_invitation_setups
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = (SELECT i.org_id FROM org_invitations i WHERE i.id = OLD.invitation_id) AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable org setup'); END;
CREATE TRIGGER org_invitation_setups_no_replace BEFORE INSERT ON org_invitation_setups
WHEN EXISTS (SELECT 1 FROM org_invitation_setups WHERE idp_token_id = NEW.idp_token_id)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: org_invitation_setups.idp_token_id'); END;

-- The developer setup (0214) gets the same refusal: none on an invitation that ended.
CREATE TRIGGER developer_invite_setups_open BEFORE INSERT ON developer_invite_setups
WHEN EXISTS (SELECT 1 FROM developer_invitations i WHERE i.id = NEW.invitation_id AND (i.revoked_at IS NOT NULL OR i.accepted_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'developer setup refused'); END;

-- A claim: at most three per invitation, on an open invitation, never past that invitation's claim window.
CREATE TRIGGER idp_invite_claims_valid BEFORE INSERT ON idp_invite_claims
WHEN (SELECT count(*) FROM idp_invite_claims
      WHERE org_invitation_id IS NEW.org_invitation_id AND developer_invitation_id IS NEW.developer_invitation_id
        AND platform_invitation_id IS NEW.platform_invitation_id) >= 3
  OR EXISTS (SELECT 1 FROM org_invitations i WHERE i.id = NEW.org_invitation_id AND (i.revoked_at IS NOT NULL OR i.accepted_at IS NOT NULL))
  OR EXISTS (SELECT 1 FROM developer_invitations i WHERE i.id = NEW.developer_invitation_id
      AND (i.revoked_at IS NOT NULL OR i.accepted_at IS NOT NULL OR NEW.claim_until > i.claim_until))
  OR EXISTS (SELECT 1 FROM platform_invitations i WHERE i.id = NEW.platform_invitation_id
      AND (i.revoked_at IS NOT NULL OR i.accepted_at IS NOT NULL OR NEW.claim_until > i.claim_until))
BEGIN SELECT RAISE(ABORT, 'claim refused'); END;
CREATE TRIGGER idp_invite_claims_immutable BEFORE UPDATE ON idp_invite_claims
WHEN NEW.id IS NOT OLD.id OR NEW.org_invitation_id IS NOT OLD.org_invitation_id
  OR NEW.developer_invitation_id IS NOT OLD.developer_invitation_id
  OR NEW.platform_invitation_id IS NOT OLD.platform_invitation_id OR NEW.subject IS NOT OLD.subject
  OR NEW.created_at IS NOT OLD.created_at OR NEW.claim_until IS NOT OLD.claim_until
  OR (OLD.swept_at IS NOT NULL AND NEW.swept_at IS NOT OLD.swept_at)
BEGIN SELECT RAISE(ABORT, 'immutable claim'); END;
CREATE TRIGGER idp_invite_claims_no_delete BEFORE DELETE ON idp_invite_claims
WHEN NOT EXISTS (SELECT 1 FROM orgs o
  WHERE o.id = COALESCE((SELECT i.org_id FROM org_invitations i WHERE i.id = OLD.org_invitation_id),
                        (SELECT i.org_id FROM developer_invitations i WHERE i.id = OLD.developer_invitation_id))
    AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable claim'); END;
CREATE TRIGGER idp_invite_claims_no_replace BEFORE INSERT ON idp_invite_claims
WHEN EXISTS (SELECT 1 FROM idp_invite_claims WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: idp_invite_claims.id'); END;

CREATE TRIGGER idp_drift_immutable BEFORE UPDATE ON idp_drift
WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.subject IS NOT OLD.subject OR NEW.target IS NOT OLD.target OR NEW.kind IS NOT OLD.kind
  OR NEW.found_at IS NOT OLD.found_at
  OR (OLD.resolved_at IS NOT NULL AND (NEW.resolved_at IS NOT OLD.resolved_at OR NEW.resolution IS NOT OLD.resolution))
BEGIN SELECT RAISE(ABORT, 'immutable drift'); END;
CREATE TRIGGER idp_drift_no_delete BEFORE DELETE ON idp_drift
BEGIN SELECT RAISE(ABORT, 'immutable drift'); END;
CREATE TRIGGER idp_drift_no_replace BEFORE INSERT ON idp_drift
WHEN EXISTS (SELECT 1 FROM idp_drift WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: idp_drift.id'); END;

-- Consistency rails on the 0214 tables: a sponsorship belongs to its invitation's org, and a paired org
-- invitation has the same org and address.
CREATE TRIGGER developer_sponsors_org_matches BEFORE INSERT ON developer_sponsors
WHEN NEW.org_id IS NOT (SELECT i.org_id FROM developer_invitations i WHERE i.id = NEW.invitation_id)
BEGIN SELECT RAISE(ABORT, 'sponsor org differs from its invitation'); END;
CREATE TRIGGER developer_invitations_paired_matches BEFORE INSERT ON developer_invitations
WHEN NEW.org_invitation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM org_invitations o
  WHERE o.id = NEW.org_invitation_id AND o.org_id = NEW.org_id AND o.email = NEW.email)
BEGIN SELECT RAISE(ABORT, 'paired invitation differs in org or address'); END;

-- ---------------------------------------------------------------------------------------------------------
-- The dirty queue. Every source that can change what a subject should hold marks the subject in the same
-- transaction (a mark again resets the backoff). A user without a Polaris ID identity has nothing to project:
-- linking one (auth_identities insert) marks it.

CREATE TRIGGER idp_dirty_identity_linked AFTER INSERT ON auth_identities
WHEN NEW.provider = 'pocketid'
BEGIN
  INSERT INTO idp_dirty (subject) SELECT NEW.subject WHERE true
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;

CREATE TRIGGER idp_dirty_membership_added AFTER INSERT ON org_memberships
BEGIN
  INSERT INTO idp_dirty (subject) SELECT a.subject FROM auth_identities a WHERE a.provider = 'pocketid' AND a.user_id = NEW.user_id
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;
CREATE TRIGGER idp_dirty_membership_revoked AFTER UPDATE OF revoked_at ON org_memberships
WHEN NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  INSERT INTO idp_dirty (subject) SELECT a.subject FROM auth_identities a WHERE a.provider = 'pocketid' AND a.user_id = NEW.user_id
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;

CREATE TRIGGER idp_dirty_sponsor_added AFTER INSERT ON developer_sponsors
BEGIN
  INSERT INTO idp_dirty (subject) SELECT a.subject FROM auth_identities a WHERE a.provider = 'pocketid' AND a.user_id = NEW.user_id
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;
CREATE TRIGGER idp_dirty_sponsor_ended AFTER UPDATE OF ended_at ON developer_sponsors
WHEN NEW.ended_at IS NOT OLD.ended_at
BEGIN
  INSERT INTO idp_dirty (subject) SELECT a.subject FROM auth_identities a WHERE a.provider = 'pocketid' AND a.user_id = NEW.user_id
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;

CREATE TRIGGER idp_dirty_role_grant_added AFTER INSERT ON platform_role_grants
BEGIN
  INSERT INTO idp_dirty (subject) SELECT a.subject FROM auth_identities a WHERE a.provider = 'pocketid' AND a.user_id = NEW.user_id
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;
CREATE TRIGGER idp_dirty_role_grant_revoked AFTER UPDATE OF revoked_at ON platform_role_grants
WHEN NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  INSERT INTO idp_dirty (subject) SELECT a.subject FROM auth_identities a WHERE a.provider = 'pocketid' AND a.user_id = NEW.user_id
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;

CREATE TRIGGER idp_dirty_user_status AFTER UPDATE OF status ON users
WHEN NEW.status IS NOT OLD.status
BEGIN
  INSERT INTO idp_dirty (subject) SELECT a.subject FROM auth_identities a WHERE a.provider = 'pocketid' AND a.user_id = NEW.id
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;

-- An org's status decides whether its memberships count: every live member is marked.
CREATE TRIGGER idp_dirty_org_status AFTER UPDATE OF status ON orgs
WHEN NEW.status IS NOT OLD.status
BEGIN
  INSERT INTO idp_dirty (subject)
  SELECT a.subject FROM org_memberships m JOIN auth_identities a ON a.user_id = m.user_id AND a.provider = 'pocketid'
  WHERE m.org_id = NEW.id AND m.revoked_at IS NULL
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;

-- A rule starting or ending moves every live member of its org.
CREATE TRIGGER idp_dirty_rule_added AFTER INSERT ON idp_group_rules
BEGIN
  INSERT INTO idp_dirty (subject)
  SELECT a.subject FROM org_memberships m JOIN auth_identities a ON a.user_id = m.user_id AND a.provider = 'pocketid'
  WHERE m.org_id = NEW.org_id AND m.revoked_at IS NULL
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;
CREATE TRIGGER idp_dirty_rule_ended AFTER UPDATE OF ended_at ON idp_group_rules
WHEN NEW.ended_at IS NOT OLD.ended_at
BEGIN
  INSERT INTO idp_dirty (subject)
  SELECT a.subject FROM org_memberships m JOIN auth_identities a ON a.user_id = m.user_id AND a.provider = 'pocketid'
  WHERE m.org_id = NEW.org_id AND m.revoked_at IS NULL
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;

CREATE TRIGGER idp_dirty_member_added AFTER INSERT ON idp_group_members
BEGIN
  INSERT INTO idp_dirty (subject) SELECT NEW.subject WHERE true
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;
CREATE TRIGGER idp_dirty_member_removed AFTER UPDATE OF removed_at ON idp_group_members
WHEN NEW.removed_at IS NOT OLD.removed_at
BEGIN
  INSERT INTO idp_dirty (subject) SELECT NEW.subject WHERE true
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;

-- A claim is subject-keyed: it marks its subject at insert, when the sweep settles it, and when its
-- invitation ends or is accepted.
CREATE TRIGGER idp_dirty_claim_added AFTER INSERT ON idp_invite_claims
BEGIN
  INSERT INTO idp_dirty (subject) SELECT NEW.subject WHERE true
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;
CREATE TRIGGER idp_dirty_claim_swept AFTER UPDATE OF swept_at ON idp_invite_claims
WHEN NEW.swept_at IS NOT OLD.swept_at
BEGIN
  INSERT INTO idp_dirty (subject) SELECT NEW.subject WHERE true
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;
CREATE TRIGGER idp_dirty_org_invitation_ended AFTER UPDATE OF revoked_at, accepted_at ON org_invitations
WHEN NEW.revoked_at IS NOT OLD.revoked_at OR NEW.accepted_at IS NOT OLD.accepted_at
BEGIN
  INSERT INTO idp_dirty (subject)
  SELECT c.subject FROM idp_invite_claims c
  WHERE c.org_invitation_id = NEW.id
    OR c.developer_invitation_id IN (SELECT d.id FROM developer_invitations d WHERE d.org_invitation_id = NEW.id)
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;
CREATE TRIGGER idp_dirty_developer_invitation_ended AFTER UPDATE OF revoked_at, accepted_at, swept_at ON developer_invitations
WHEN NEW.revoked_at IS NOT OLD.revoked_at OR NEW.accepted_at IS NOT OLD.accepted_at OR NEW.swept_at IS NOT OLD.swept_at
BEGIN
  INSERT INTO idp_dirty (subject) SELECT c.subject FROM idp_invite_claims c WHERE c.developer_invitation_id = NEW.id
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;
CREATE TRIGGER idp_dirty_platform_invitation_ended AFTER UPDATE OF revoked_at, accepted_at, swept_at ON platform_invitations
WHEN NEW.revoked_at IS NOT OLD.revoked_at OR NEW.accepted_at IS NOT OLD.accepted_at OR NEW.swept_at IS NOT OLD.swept_at
BEGIN
  INSERT INTO idp_dirty (subject)
  SELECT c.subject FROM idp_invite_claims c WHERE c.platform_invitation_id = NEW.id
  UNION SELECT NEW.accepted_subject WHERE NEW.accepted_subject IS NOT NULL
  ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0;
END;

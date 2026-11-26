import { all, first } from '../../platform/db.ts';

/** The PassBook user behind a Polaris ID subject, with what the desired state needs of them. */
export interface IdentityRow {
  user_id: string;
  status: 'active' | 'disabled';
  last_roles: string;
}

export const identityOfSubject = (db: D1Database, subject: string) =>
  first<IdentityRow>(
    db,
    `SELECT u.id AS user_id, u.status, u.last_roles FROM auth_identities a JOIN users u ON u.id = a.user_id
     WHERE a.provider = 'pocketid' AND a.subject = ?`,
    [subject],
  );

/** The Polaris ID subjects linked to a user. */
export const subjectsOfUser = async (db: D1Database, userId: string): Promise<string[]> =>
  (
    await all<{ subject: string }>(
      db,
      "SELECT subject FROM auth_identities WHERE provider = 'pocketid' AND user_id = ? ORDER BY subject",
      [userId],
    )
  ).map((r) => r.subject);

export interface MembershipSource {
  org_id: string;
  kind: 'standard' | 'developer';
  roles: string;
}

/** Live memberships in orgs that count: active or suspended, never a personal org. Developer sandboxes are included. */
export const membershipSources = (db: D1Database, userId: string) =>
  all<MembershipSource>(
    db,
    `SELECT m.org_id, o.kind, m.roles FROM org_memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.user_id = ? AND m.revoked_at IS NULL AND o.status IN ('active', 'suspended') AND o.personal_user_id IS NULL
     ORDER BY m.org_id`,
    [userId],
  );

/**
 * Orgs where the user has a live sponsorship as a developer. Only an active standard org sponsors: a suspended,
 * closed or deleted one no longer vouches, and a personal org never does.
 */
export const sponsorOrgs = async (db: D1Database, userId: string): Promise<string[]> =>
  (
    await all<{ org_id: string }>(
      db,
      `SELECT p.org_id FROM developer_sponsors p JOIN orgs o ON o.id = p.org_id
       WHERE p.user_id = ? AND p.ended_at IS NULL
         AND o.status = 'active' AND o.kind = 'standard' AND o.personal_user_id IS NULL
       ORDER BY p.org_id`,
      [userId],
    )
  ).map((r) => r.org_id);

export interface RuleSource {
  rule_id: string;
  group_key: string;
  org_id: string;
}

/** Live org rules the user meets: a live membership in a standard org with a listed role (any role when none is listed). */
export const ruleSources = (db: D1Database, userId: string) =>
  all<RuleSource>(
    db,
    `SELECT r.id AS rule_id, r.group_key, r.org_id
     FROM idp_group_rules r
     JOIN idp_groups g ON g.key = r.group_key AND g.deleted_at IS NULL
     JOIN org_memberships m ON m.org_id = r.org_id AND m.user_id = ? AND m.revoked_at IS NULL
     JOIN orgs o ON o.id = r.org_id AND o.status IN ('active', 'suspended') AND o.personal_user_id IS NULL AND o.kind = 'standard'
     WHERE r.ended_at IS NULL
       AND (r.org_roles IS NULL OR EXISTS (SELECT 1 FROM json_each(m.roles) mr WHERE mr.value IN (SELECT value FROM json_each(r.org_roles))))
     ORDER BY r.group_key, r.org_id`,
    [userId],
  );

/** Live org rules of an org that an invited set of org roles meets (what a claim on that invitation wants). */
export const ruleSourcesForRoles = (db: D1Database, orgId: string, rolesJson: string) =>
  all<RuleSource>(
    db,
    `SELECT r.id AS rule_id, r.group_key, r.org_id
     FROM idp_group_rules r
     JOIN idp_groups g ON g.key = r.group_key AND g.deleted_at IS NULL
     JOIN orgs o ON o.id = r.org_id AND o.status IN ('active', 'suspended') AND o.personal_user_id IS NULL AND o.kind = 'standard'
     WHERE r.org_id = ? AND r.ended_at IS NULL
       AND (r.org_roles IS NULL OR EXISTS (SELECT 1 FROM json_each(?) ir WHERE ir.value IN (SELECT value FROM json_each(r.org_roles))))
     ORDER BY r.group_key`,
    [orgId, rolesJson],
  );

export interface MemberSource {
  id: string;
  group_key: string;
  source: 'manual' | 'invitation';
}

/** Live manual and invitation memberships of a subject in groups that still exist. */
export const memberSources = (db: D1Database, subject: string) =>
  all<MemberSource>(
    db,
    `SELECT m.id, m.group_key, m.source FROM idp_group_members m
     JOIN idp_groups g ON g.key = m.group_key AND g.deleted_at IS NULL
     WHERE m.subject = ? AND m.removed_at IS NULL ORDER BY m.group_key`,
    [subject],
  );

export interface ClaimSource {
  id: string;
  invitation: 'member' | 'developer' | 'platform';
  /** The org and roles of the member invitation, direct or paired with a developer one and still open. */
  org_id: string | null;
  org_roles: string | null;
  /** Platform invitations: the chosen group keys and whether developer is chosen. */
  groups: string | null;
  developer: number | null;
}

/**
 * Claims of a subject that are inside their window and whose invitation is still open (not revoked,
 * or accepted). An accepted invitation moves its reason to the membership, sponsorship or group row.
 */
export const claimSources = (db: D1Database, subject: string, now: number) =>
  all<ClaimSource>(
    db,
    `SELECT c.id,
       CASE WHEN c.org_invitation_id IS NOT NULL THEN 'member'
            WHEN c.developer_invitation_id IS NOT NULL THEN 'developer' ELSE 'platform' END AS invitation,
       COALESCE(oi.org_id, po.org_id) AS org_id, COALESCE(oi.roles, po.roles) AS org_roles,
       pi.groups, pi.developer
     FROM idp_invite_claims c
     LEFT JOIN org_invitations oi ON oi.id = c.org_invitation_id
       AND oi.revoked_at IS NULL AND oi.accepted_at IS NULL AND oi.expires_at > ?
       AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = oi.org_id AND o.status IN ('active', 'suspended'))
     LEFT JOIN developer_invitations di ON di.id = c.developer_invitation_id
       AND di.revoked_at IS NULL AND di.accepted_at IS NULL
       AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = di.org_id AND o.status = 'active'
                     AND o.kind = 'standard' AND o.personal_user_id IS NULL)
     LEFT JOIN org_invitations po ON po.id = di.org_invitation_id
       AND po.revoked_at IS NULL AND po.accepted_at IS NULL AND po.expires_at > ?
       AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = po.org_id AND o.status IN ('active', 'suspended'))
     LEFT JOIN platform_invitations pi ON pi.id = c.platform_invitation_id
       AND pi.revoked_at IS NULL AND pi.accepted_at IS NULL
     WHERE c.subject = ? AND c.claim_until > ? AND c.swept_at IS NULL
       AND (oi.id IS NOT NULL OR di.id IS NOT NULL OR pi.id IS NOT NULL)
     ORDER BY c.created_at, c.id`,
    [now, now, subject, now],
  );

/** The keys among `keys` that name a group that still exists. */
export async function liveGroupKeys(db: D1Database, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await all<{ key: string }>(
    db,
    `SELECT key FROM idp_groups WHERE deleted_at IS NULL AND key IN (${keys.map(() => '?').join(',')})`,
    keys,
  );
  return new Set(rows.map((r) => r.key));
}

/** The user is active and has a live, unrevoked session with the admin role (a demotion in Polaris ID ends it). */
export async function hasLiveAdminSession(
  db: D1Database,
  userId: string,
  now: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 AS ok FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.user_id = ? AND u.status = 'active' AND s.revoked_at IS NULL AND s.amr = 'oidc'
         AND s.expires_at > ? AND s.idle_expires_at > ? AND json_valid(s.roles)
         AND EXISTS (SELECT 1 FROM json_each(s.roles) r WHERE r.type = 'text' AND r.value = 'admin')
       LIMIT 1`,
      [userId, now, now],
    )) !== null
  );
}

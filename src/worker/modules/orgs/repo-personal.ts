import type { EntitlementPreset } from '../../../shared/contracts/entitlements.ts';
import { grant } from '../../platform/authority.ts';
import {
  CREATOR_ORG_PURPOSE,
  PERSONAL_ORG_PURPOSE,
  PERSONAL_ORG_TABLES,
} from '../../platform/authority-personal.ts';
import { all, first, placeholders } from '../../platform/db.ts';
import { addOrgEntitlements } from '../../platform/entitlements.ts';
import { knownEmailSql } from '../../platform/known-email-sql.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { OrgRow } from './repo.ts';
import type { OrgAdmin } from './repo-org-writes.ts';

export interface PersonalUser {
  id: string;
  name: string | null;
  /** The verified address, never the placeholder. */
  email: string | null;
  /** As stored: the invitation row needs an address, and a placeholder does for that. */
  primary_email: string;
  status: 'active' | 'disabled';
}

export function getPersonalUser(db: D1Database, userId: string) {
  return first<PersonalUser>(
    db,
    `SELECT id, name, ${knownEmailSql('primary_email')} AS email, primary_email, status FROM users WHERE id = ?`,
    [userId],
  );
}

/** Any status: a closed personal org still marks its owner as served. */
export function personalOrgIdOf(db: D1Database, userId: string) {
  return first<{ id: string }>(db, 'SELECT id FROM orgs WHERE personal_user_id = ?', [userId]);
}

/** The owner of a personal org; null for any other org, or an unknown id. */
export async function personalOwnerOf(db: D1Database, orgId: string): Promise<string | null> {
  const row = await first<{ owner: string | null }>(
    db,
    'SELECT personal_user_id AS owner FROM orgs WHERE id = ?',
    [orgId],
  );
  return row?.owner ?? null;
}

export async function isPersonalOrg(db: D1Database, orgId: string): Promise<boolean> {
  return (
    (await first(db, 'SELECT 1 AS x FROM orgs WHERE id = ? AND personal_user_id IS NOT NULL', [
      orgId,
    ])) !== null
  );
}

/** Owner ids and names of personal orgs, for the platform directory. */
export async function personalOwners(db: D1Database, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string | null>();
  const rows = await all<{ id: string; name: string | null }>(
    db,
    `SELECT id, name FROM users WHERE id IN (${placeholders(userIds.length)})`,
    userIds,
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

export interface PersonalOrgInsert {
  orgId: string;
  slug: string;
  name: string;
  userId: string;
  email: string;
  invitationId: string;
  membershipId: string;
  tokenHash: string;
  now: number;
}

/**
 * `platform.org.personal`: the org, its entitlements row, an accepted invitation, the org_admin
 * membership and the audit row commit together, only for the live admin session's own user.
 */
export async function insertPersonalOrg(
  ctx: ServiceContext,
  row: PersonalOrgInsert,
  admin: OrgAdmin,
): Promise<void> {
  const g = grant(ctx, {
    purpose: PERSONAL_ORG_PURPOSE,
    principal: { kind: 'platform', userId: admin.userId, sessionIdHash: admin.sessionId },
    target: row.orgId,
    tables: PERSONAL_ORG_TABLES,
  });
  const roles = '["org_admin"]';
  g.insertSelect(
    'orgs',
    [
      'id',
      'slug',
      'name',
      'status',
      'default_identity_id',
      'branding',
      'created_at',
      'updated_at',
      'personal_user_id',
    ],
    [row.orgId, row.slug, row.name, 'active', null, '{}', row.now, row.now, row.userId],
  );
  addOrgEntitlements(g, row.orgId, 'legacy', row.now);
  g.insertSelect(
    'org_invitations',
    ['id', 'org_id', 'email', 'roles', 'token_hash', 'created_at', 'expires_at', 'accepted_at'],
    [row.invitationId, row.orgId, row.email, roles, row.tokenHash, row.now, row.now, row.now],
  );
  g.insertSelect(
    'org_memberships',
    ['id', 'org_id', 'user_id', 'invitation_id', 'roles', 'created_at'],
    [row.membershipId, row.orgId, row.userId, row.invitationId, roles, row.now],
  );
  grantedAudit(g, ctx, {
    actorType: 'user',
    actorId: row.userId,
    orgId: row.orgId,
    action: 'org.create',
    targetType: 'org',
    targetId: row.orgId,
    detail: { slug: row.slug, preset: 'legacy', personal: true },
  });
  await g.commit();
}

export interface CreatorMembership {
  email: string;
  invitationId: string;
  membershipId: string;
  tokenHash: string;
}

/**
 * `platform.org.create_admin`: the org, its entitlements row, the creator's accepted invitation and
 * `org_admin` membership commit together, only while the admin session is live.
 */
export async function insertOrgWithCreator(
  ctx: ServiceContext,
  row: Omit<OrgRow, 'config_revision' | 'personal_user_id'>,
  admin: OrgAdmin,
  preset: EntitlementPreset,
  member: CreatorMembership,
): Promise<void> {
  const g = grant(ctx, {
    purpose: CREATOR_ORG_PURPOSE,
    principal: { kind: 'platform', userId: admin.userId, sessionIdHash: admin.sessionId },
    target: row.id,
    tables: PERSONAL_ORG_TABLES,
  });
  const roles = '["org_admin"]';
  g.insertSelect(
    'orgs',
    ['id', 'slug', 'name', 'status', 'default_identity_id', 'branding', 'created_at', 'updated_at'],
    [
      row.id,
      row.slug,
      row.name,
      row.status,
      row.default_identity_id,
      row.branding,
      row.created_at,
      row.updated_at,
    ],
  );
  addOrgEntitlements(g, row.id, preset, row.updated_at);
  g.insertSelect(
    'org_invitations',
    ['id', 'org_id', 'email', 'roles', 'token_hash', 'created_at', 'expires_at', 'accepted_at'],
    [
      member.invitationId,
      row.id,
      member.email,
      roles,
      member.tokenHash,
      row.created_at,
      row.created_at,
      row.created_at,
    ],
  );
  g.insertSelect(
    'org_memberships',
    ['id', 'org_id', 'user_id', 'invitation_id', 'roles', 'created_at'],
    [member.membershipId, row.id, admin.userId, member.invitationId, roles, row.created_at],
  );
  await g.commit();
}

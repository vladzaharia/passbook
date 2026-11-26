import type {
  OrgCapability,
  OrgMember,
  OrgMembership,
  OrgRole,
} from '../../../shared/contracts/org-membership.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { ORG_CAPABILITIES, ROLE_GRANTS } from '../../platform/org-role-grants.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { viewerOrgName } from './personal-names.ts';
import { activeMembership, type MembershipRow, myMemberships } from './repo-members.ts';

export { rolesGranting } from '../../platform/org-role-grants.ts';

function validRoles(value: unknown): value is OrgRole[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((role) => typeof role === 'string' && Object.hasOwn(ROLE_GRANTS, role)) &&
    new Set(value).size === value.length
  );
}
export function parseRoles(json: string): OrgRole[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ForbiddenError();
  }
  if (!validRoles(value)) throw new ForbiddenError();
  return value;
}
export function memberDto(row: MembershipRow): OrgMember {
  return {
    ...membershipDto(row),
    userName: row.user_name,
    userEmail: row.user_email,
    ...(row.access_paused === 1 ? { accessPaused: true } : {}),
  };
}
/** `own`: the viewer's own membership list, where their personal org is called "Personal". */
export function membershipDto(row: MembershipRow, own = false): OrgMembership {
  const roles = parseRoles(row.roles);
  const allowed = new Set(roles.flatMap((role) => ROLE_GRANTS[role]));
  return {
    id: row.id,
    orgId: row.org_id,
    orgName: own
      ? viewerOrgName({ name: row.org_name, personal_user_id: row.personal_user_id }, row.user_id)
      : row.org_name,
    personal: row.personal_user_id !== null,
    testOnly: row.org_kind === 'developer',
    orgSlug: row.org_slug,
    userId: row.user_id,
    roles,
    capabilities: ORG_CAPABILITIES.filter((capability) => allowed.has(capability)),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}
export async function getOrgAccess(
  ctx: ServiceContext,
  userId: string,
  orgId: string,
): Promise<OrgMembership | null> {
  const row = await activeMembership(ctx.env.DB, userId, orgId);
  return row ? membershipDto(row, true) : null;
}
export async function requireOrgCapability(
  ctx: ServiceContext,
  userId: string,
  orgId: string,
  capability: OrgCapability,
): Promise<OrgMembership> {
  if (!ORG_CAPABILITIES.includes(capability)) throw new ForbiddenError();
  const membership = await getOrgAccess(ctx, userId, orgId);
  if (!membership?.capabilities.includes(capability)) throw new ForbiddenError();
  return membership;
}
export async function listMyOrgMemberships(
  ctx: ServiceContext,
  userId: string,
): Promise<OrgMembership[]> {
  return (await myMemberships(ctx.env.DB, userId)).map((row) => membershipDto(row, true));
}

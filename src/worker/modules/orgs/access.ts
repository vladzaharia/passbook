import {
  type OrgCapability,
  OrgCapabilitySchema,
  type OrgMember,
  type OrgMembership,
  type OrgRole,
} from '../../../shared/contracts/org-membership.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { activeMembership, type MembershipRow, myMemberships } from './repo-members.ts';

const capabilities: OrgCapability[] = [...OrgCapabilitySchema.options];
const grants: Record<OrgRole, OrgCapability[]> = {
  org_admin: capabilities,
  integration_admin: ['org:read', 'integrations:read', 'integrations:manage', 'templates:read'],
  template_author: ['org:read', 'templates:read', 'templates:author'],
  template_reviewer: ['org:read', 'templates:read', 'templates:review'],
  template_publisher: ['org:read', 'templates:read', 'templates:publish'],
  pass_operator: [
    'org:read',
    'templates:read',
    'passes:read',
    'passes:operate',
    'messages:read',
    'messages:manage',
    'scanning:read',
    'audit:read',
  ],
  read_only: [
    'org:read',
    'integrations:read',
    'templates:read',
    'passes:read',
    'messages:read',
    'scanning:read',
    'audit:read',
  ],
};

/** Roles whose current membership grants a capability, for commit-time predicates. */
export function rolesGranting(capability: OrgCapability): OrgRole[] {
  return (Object.keys(grants) as OrgRole[]).filter((role) => grants[role].includes(capability));
}
function validRoles(value: unknown): value is OrgRole[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((role) => typeof role === 'string' && Object.hasOwn(grants, role)) &&
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
  return { ...membershipDto(row), userName: row.user_name, userEmail: row.user_email };
}
export function membershipDto(row: MembershipRow): OrgMembership {
  const roles = parseRoles(row.roles);
  const allowed = new Set(roles.flatMap((role) => grants[role]));
  return {
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    orgSlug: row.org_slug,
    userId: row.user_id,
    roles,
    capabilities: capabilities.filter((capability) => allowed.has(capability)),
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
  return row ? membershipDto(row) : null;
}
export async function requireOrgCapability(
  ctx: ServiceContext,
  userId: string,
  orgId: string,
  capability: OrgCapability,
): Promise<OrgMembership> {
  if (!capabilities.includes(capability)) throw new ForbiddenError();
  const membership = await getOrgAccess(ctx, userId, orgId);
  if (!membership?.capabilities.includes(capability)) throw new ForbiddenError();
  return membership;
}
export async function listMyOrgMemberships(
  ctx: ServiceContext,
  userId: string,
): Promise<OrgMembership[]> {
  return (await myMemberships(ctx.env.DB, userId)).map(membershipDto);
}

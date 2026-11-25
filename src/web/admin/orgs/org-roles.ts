import type { OrgRole } from '@/shared/contracts/org-membership.ts';

export const ROLE_LABELS: Record<OrgRole, string> = {
  org_admin: 'Organization admin',
  integration_admin: 'Integration admin',
  template_author: 'Template author',
  template_reviewer: 'Template reviewer',
  template_publisher: 'Template publisher',
  pass_operator: 'Pass operator',
  read_only: 'Read only',
};
export const ROLES = Object.keys(ROLE_LABELS) as OrgRole[];

/** These two stand alone: Organization admin covers the rest, Read only conflicts with them. */
export type ExclusiveRole = 'org_admin' | 'read_only';

export function exclusiveOf(roles: readonly OrgRole[]): ExclusiveRole | null {
  if (roles.includes('org_admin')) return 'org_admin';
  if (roles.includes('read_only')) return 'read_only';
  return null;
}

/** Picking an exclusive role replaces the others; any other role is toggled. */
export function toggleRole(roles: readonly OrgRole[], role: OrgRole, on: boolean): OrgRole[] {
  if (!on) return roles.filter((r) => r !== role);
  if (role === 'org_admin' || role === 'read_only') return [role];
  return roles.includes(role) ? [...roles] : [...roles, role];
}

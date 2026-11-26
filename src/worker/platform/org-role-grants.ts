import {
  type OrgCapability,
  OrgCapabilitySchema,
  type OrgRole,
} from '../../shared/contracts/org-membership.ts';

export const ORG_CAPABILITIES: OrgCapability[] = [...OrgCapabilitySchema.options];

export const ROLE_GRANTS: Record<OrgRole, OrgCapability[]> = {
  org_admin: ORG_CAPABILITIES,
  integration_admin: [
    'org:read',
    'integrations:read',
    'integrations:manage',
    'templates:read',
    'logs:read',
  ],
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
    'logs:read',
  ],
};

/** Roles whose current membership grants a capability, for commit-time predicates. */
export function rolesGranting(capability: OrgCapability): OrgRole[] {
  return (Object.keys(ROLE_GRANTS) as OrgRole[]).filter((role) =>
    ROLE_GRANTS[role].includes(capability),
  );
}

/** Capabilities that administer the org, its members or its credentials: granting one needs a recent sign-in. */
const ADMIN_CAPABILITIES: OrgCapability[] = ['org:manage', 'members:manage', 'integrations:manage'];

/** Roles that hold an administering capability, read from the grants above so a new role is covered. */
export const ADMINISTERING_ROLES: readonly OrgRole[] = (
  Object.keys(ROLE_GRANTS) as OrgRole[]
).filter((role) => ROLE_GRANTS[role].some((capability) => ADMIN_CAPABILITIES.includes(capability)));

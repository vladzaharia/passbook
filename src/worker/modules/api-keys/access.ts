import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { API_SCOPES, type ApiScope } from '../../platform/auth.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { rolesGranting } from '../orgs/access.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';

export type ApiKeyAuthority =
  | { kind: 'platform'; userId: string; sessionId: string }
  | Extract<TenantPassWrite, { kind: 'session' }>;

/** An org filter selects a tenant; it never grants authority over that tenant. */
export async function authorizeApiKeys(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string | null,
  capability: 'integrations:read' | 'integrations:manage',
): Promise<ApiKeyAuthority> {
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  if (orgId === null) {
    if (!auth.roles.includes('admin')) throw new ForbiddenError();
    return { kind: 'platform', userId: auth.userId, sessionId: auth.sessionId };
  }
  const authority = await tenantAuthorityOf(ctx, auth, orgId, capability);
  if (authority.kind !== 'session') throw new ForbiddenError();
  return authority;
}

export function authorityOrgId(authority: ApiKeyAuthority): string | null {
  return authority.kind === 'session' ? authority.orgId : null;
}

/** The capability a key scope exercises; the same table tenantAuthorityOf applies to keys. */
export const scopeCapability: Record<ApiScope, OrgCapability> = {
  'passes:read': 'passes:read',
  'passes:write': 'passes:operate',
  'holders:write': 'passes:operate',
  'templates:read': 'templates:read',
  'messages:write': 'messages:manage',
  'scans:read': 'scanning:read',
  'connections:read': 'integrations:read',
  'connections:write': 'integrations:manage',
};

/** Scopes a creator may delegate: platform admins any, members only what their roles grant. */
export function delegableScopes(authority: ApiKeyAuthority): ApiScope[] {
  if (authority.kind === 'platform') return [...API_SCOPES];
  return API_SCOPES.filter((scope) =>
    rolesGranting(scopeCapability[scope]).some((role) => authority.roles.includes(role)),
  );
}

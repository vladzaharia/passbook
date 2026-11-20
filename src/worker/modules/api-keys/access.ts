import { MINTABLE_SCOPES } from '../../../shared/contracts/api-keys.ts';
import { isPlatformScope, scopeCapability } from '../../platform/api-scopes.ts';
import type { ApiScope, AuthContext } from '../../platform/auth.ts';
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
  capability: 'org:read' | 'integrations:read' | 'integrations:manage',
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

/**
 * Scopes a creator may delegate: platform admins any mintable one, members only what their roles
 * grant. A scope no route accepts yet is not mintable; platform scopes have no org capability, so
 * a member never holds them.
 */
export function delegableScopes(authority: ApiKeyAuthority): ApiScope[] {
  if (authority.kind === 'platform') return [...MINTABLE_SCOPES];
  return MINTABLE_SCOPES.filter(
    (scope) =>
      !isPlatformScope(scope) &&
      rolesGranting(scopeCapability[scope]).some((role) => authority.roles.includes(role)),
  );
}

import {
  MINTABLE_SCOPES,
  PLATFORM_KEY_SCOPES,
  TEMPLATE_ACT_AS_SCOPES,
} from '../../../shared/contracts/api-keys.ts';
import { CREDENTIAL_SCOPES, isPlatformScope, scopeCapability } from '../../platform/api-scopes.ts';
import type { Amr, ApiScope, AuthContext } from '../../platform/auth.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { rolesGranting } from '../orgs/access.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';

/** Scopes no child holds: minting stops at one level, a terminal's scope is bound to its terminals, and a key never mints a credential scope. */
export const CHILD_NEVER: readonly ApiScope[] = [
  'api-keys:write',
  'scans:write',
  ...CREDENTIAL_SCOPES,
  // These act as the key's creator, and a child has none.
  ...TEMPLATE_ACT_AS_SCOPES,
  // A key never mints a Platform key, and a service key never holds a platform scope.
  ...PLATFORM_KEY_SCOPES,
];

/** A key caller is a service key of the org (it holds `api-keys:write`): it reaches its own children only. */
export type ApiKeyAuthority =
  | { kind: 'platform'; userId: string; sessionId: string; amr: Amr }
  | Extract<TenantPassWrite, { kind: 'session' | 'api_key' }>;

/** An org filter selects a tenant; it never grants authority over that tenant. */
export async function authorizeApiKeys(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string | null,
  capability: 'org:read' | 'integrations:read' | 'integrations:manage' | 'audit:read',
): Promise<ApiKeyAuthority> {
  if (auth?.kind === 'api_key') {
    // A key acts in its own org only (a platform key names none), and always as `integrations:manage`.
    if (orgId === null || auth.orgId !== orgId) throw new ForbiddenError();
    const authority = await tenantAuthorityOf(ctx, auth, orgId, 'integrations:manage');
    if (authority.kind !== 'api_key') throw new ForbiddenError();
    return authority;
  }
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  if (orgId === null) {
    if (!auth.roles.includes('admin')) throw new ForbiddenError();
    return { kind: 'platform', userId: auth.userId, sessionId: auth.sessionId, amr: auth.amr };
  }
  const authority = await tenantAuthorityOf(ctx, auth, orgId, capability);
  if (authority.kind !== 'session') throw new ForbiddenError();
  return authority;
}

/** The audit actor of a call: the person, or the key. */
export function actorOf(authority: ApiKeyAuthority): {
  actorType: 'user' | 'api_key';
  actorId: string;
} {
  return authority.kind === 'api_key'
    ? { actorType: 'api_key', actorId: authority.keyId }
    : { actorType: 'user', actorId: authority.userId };
}

export function authorityOrgId(authority: ApiKeyAuthority): string | null {
  return authority.kind === 'platform' ? null : authority.orgId;
}

/**
 * Scopes a creator may delegate: platform admins any mintable one, members only what their roles
 * grant. A scope no route accepts yet is not mintable; platform scopes have no org capability, so
 * a member never holds them.
 */
export function delegableScopes(authority: ApiKeyAuthority): ApiScope[] {
  if (authority.kind === 'platform') return [...MINTABLE_SCOPES];
  // A child holds a subset of its parent's scopes, but never the right to mint (one level) or a terminal's scope.
  if (authority.kind === 'api_key')
    return authority.scopes.filter((scope) => !CHILD_NEVER.includes(scope));
  return MINTABLE_SCOPES.filter(
    (scope) =>
      !isPlatformScope(scope) &&
      rolesGranting(scopeCapability[scope]).some((role) => authority.roles.includes(role)),
  );
}

import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import { type AuthContext, proveCapability } from '../../platform/auth.ts';
import type { Check } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import { managerOf } from '../orgs/membership-service.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';

/** Who acts on an org's developers: the principal and checks a grant re-derives, and how the audit names them. */
export interface DevActor {
  principal: Principal;
  checks: Check[];
  actorType: 'user' | 'api_key';
  actorId: string;
  /** How the call came in, for the audit detail. */
  via: 'console' | 'api';
  /** The session's user, or null for a key. */
  userId: string | null;
}

/**
 * A session needs `members:manage` (or a platform admin acting on the org); a key must be Live and name
 * `members:write` (or `members:read` for reads), checked here and again in the grant.
 */
export async function devActorOf(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  capability: Extract<OrgCapability, 'members:read' | 'members:manage'>,
): Promise<DevActor> {
  if (auth.kind === 'session') {
    const manager = await managerOf(ctx, auth, orgId);
    proveCapability(auth, capability);
    return {
      ...manager,
      actorType: 'user',
      actorId: auth.userId,
      via: 'console',
      userId: auth.userId,
    };
  }
  if (auth.kind !== 'api_key') throw new UnauthenticatedError();
  const authority = await tenantAuthorityOf(ctx, auth, orgId, capability);
  if (authority.kind !== 'api_key') throw new ForbiddenError();
  if (authority.mode !== 'live')
    throw new ForbiddenError(
      'Use a live key to manage members.',
      capability === 'members:manage' ? 'MODE_LIVE_REQUIRED' : undefined,
    );
  return {
    principal: tenantPrincipal(authority),
    checks: capabilityChecks(authority),
    actorType: 'api_key',
    actorId: authority.keyId,
    via: 'api',
    userId: null,
  };
}

export const auditOf = (
  actor: DevActor,
  orgId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
): AuditEntry => ({
  orgId,
  actorType: actor.actorType,
  actorId: actor.actorId,
  action,
  targetType,
  targetId,
  ...(detail ? { detail } : {}),
});

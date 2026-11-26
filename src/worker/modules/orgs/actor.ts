import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import type { Actor } from '../../platform/actor.ts';
import { type AuthContext, proveCapability, type SessionAuth } from '../../platform/auth.ts';
import type { Check } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { ADMINISTERING_ROLES } from '../../platform/org-role-grants.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import {
  capabilityChecks,
  membershipCapability,
  tenantPrincipal,
} from '../passes/repo-authority.ts';
import { requireOrgCapability } from './access.ts';
import * as repo from './repo-members.ts';

/**
 * Who manages the org for this request, as a grant principal: a platform admin whose session is live
 * (acting on this org while it is active), or a member holding `members:manage` with a live session.
 * The grant re-checks the principal inside the write; the capability is re-derived from the membership's
 * own roles.
 */
export async function managerOf(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
): Promise<{ principal: Principal; checks: Check[] }> {
  if (auth.roles.includes('admin') && (await repo.activePrincipal(ctx.env.DB, auth.userId, orgId)))
    return {
      principal: { kind: 'platform', userId: auth.userId, sessionIdHash: auth.sessionId, orgId },
      checks: [],
    };
  const membership = await requireOrgCapability(ctx, auth.userId, orgId, 'members:manage');
  return {
    principal: {
      kind: 'membership',
      membershipId: membership.id,
      via: 'session',
      sessionIdHash: auth.sessionId,
    },
    checks: [membershipCapability(membership.id, 'members:manage')],
  };
}

/**
 * An org route's caller. A session manages the org (`managerOf`: `members:manage`, or a platform admin acting on
 * it) and proves the route's `capability`. A key must be Live, in this org, and hold the scope behind `capability`,
 * checked here and again in the grant. Test keys and platform keys never get here.
 */
export async function orgActorOf(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  capability: OrgCapability,
): Promise<Actor> {
  if (auth.kind === 'session') {
    const manager = await managerOf(ctx, auth, orgId);
    proveCapability(auth, capability);
    return {
      ...manager,
      actorType: 'user',
      actorId: auth.userId,
      via: 'console',
      userId: auth.userId,
      keyId: null,
      sender: { kind: 'person', userId: auth.userId },
      rateKey: `user:${auth.userId}`,
    };
  }
  if (auth.kind !== 'api_key') throw new UnauthenticatedError();
  const authority = await tenantAuthorityOf(ctx, auth, orgId, capability);
  if (authority.kind !== 'api_key' || authority.mode !== 'live') throw new ForbiddenError();
  return {
    principal: tenantPrincipal(authority),
    checks: capabilityChecks(authority),
    actorType: 'api_key',
    actorId: authority.keyId,
    via: 'api',
    userId: null,
    keyId: authority.keyId,
    sender: { kind: 'org', orgId },
    rateKey: `key:${authority.keyId}`,
  };
}

/** The audit entry for an org action; a key's calls say `via: 'api'`. */
export function auditOf(
  actor: Actor,
  orgId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
): AuditEntry {
  const full = actor.via === 'api' ? { ...detail, via: 'api' } : detail;
  return {
    orgId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action,
    targetType,
    targetId,
    ...(full ? { detail: full } : {}),
  };
}

/** 403 `KEY_CANNOT_ADMINISTER`: a key never gives, removes or changes a role that administers the org. */
export function keyRoleGuard(actor: Actor, roles: readonly string[]): void {
  if (
    actor.keyId !== null &&
    roles.some((r) => (ADMINISTERING_ROLES as readonly string[]).includes(r))
  )
    throw new ForbiddenError('Give or remove admin roles in the console.', 'KEY_CANNOT_ADMINISTER');
}

import type { Context, MiddlewareHandler } from 'hono';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { OrgCapability, OrgRole } from '../../../shared/contracts/org-membership.ts';
import { scopeExercises } from '../../platform/api-scopes.ts';
import {
  type Amr,
  type ApiScope,
  type AuthContext,
  assertOrgAccess,
  modeOf,
  type Role,
  requireCaller,
  type ScopeRule,
  verifiedScopeOf,
} from '../../platform/auth.ts';
import { type AppBindings, actorOf } from '../../platform/context.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { declareKeyAccess, keyAccessOf } from '../../platform/openapi-security.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { requireOrgCapability } from '../orgs/access.ts';
import { loadUserAccessRevision } from './repo-access-revision.ts';
import { tenantOrgAccessRevision, tenantPassAuthorityValid } from './repo-authority.ts';
import type { PassScope } from './scope.ts';
import type { Actor } from './service.ts';

export type C = Context<AppBindings>;

export const svc = serviceContext;

/** The exact operation scope already verified by the tenant API-key guard (`requireCaller`). */
export function tenantKeyScopeOf(auth: AuthContext): ApiScope | undefined {
  return verifiedScopeOf(auth);
}

export function authOf(c: C): AuthContext {
  const auth = c.var.auth;
  if (!auth) throw new UnauthenticatedError();
  return auth;
}

/**
 * A credential and exact membership captured before a tenant operation starts.
 * `orgAccessRevision` is the org's `access_revision` (only status moves it).
 */
export type TenantPassWrite =
  | {
      kind: 'session';
      orgId: string;
      orgAccessRevision: number;
      userId: string;
      /** `users.access_revision` when captured: deferred work built from this authority carries it. */
      userAccessRevision?: number;
      sessionId: string;
      sessionRoles: Role[];
      amr: Amr;
      membershipId: string;
      roles: OrgRole[];
      capability: OrgCapability;
      mode: Mode;
    }
  | {
      kind: 'api_key';
      orgId: string;
      orgAccessRevision: number;
      keyId: string;
      keyOrgId: string | null;
      scopes: ApiScope[];
      scope: ApiScope;
      mode: Mode;
    };

/**
 * Establish authority for one organization. The resulting snapshot must be repeated in the
 * actual D1 write using tenantPassAuthoritySql and tenantPassAuthorityParams.
 */
export async function tenantAuthorityOf(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  capability: OrgCapability,
): Promise<TenantPassWrite> {
  const orgAccessRevision = await tenantOrgAccessRevision(ctx.env.DB, orgId);
  if (orgAccessRevision === null) throw new ForbiddenError();
  let authority: TenantPassWrite;
  if (auth.kind === 'session') {
    const membership = await requireOrgCapability(ctx, auth.userId, orgId, capability);
    authority = {
      kind: 'session',
      orgId,
      orgAccessRevision,
      userId: auth.userId,
      userAccessRevision: (await loadUserAccessRevision(ctx.env.DB, auth.userId)) ?? 0,
      sessionId: auth.sessionId,
      sessionRoles: [...auth.roles],
      amr: auth.amr,
      membershipId: membership.id,
      roles: [...membership.roles],
      capability,
      mode: auth.mode,
    };
  } else if (auth.kind === 'api_key') {
    assertOrgAccess(auth, orgId);
    // Holder and pass routes use different scopes. The endpoint guard supplies the exact
    // scope it verified, which is checked again in the final D1 predicate.
    const scope = verifiedScopeOf(auth);
    if (!scope || !scopeExercises(scope, capability) || !auth.scopes.includes(scope))
      throw new ForbiddenError();
    authority = {
      kind: 'api_key',
      orgId,
      orgAccessRevision,
      keyId: auth.keyId,
      keyOrgId: auth.orgId,
      scopes: [...auth.scopes],
      scope,
      mode: auth.mode,
    };
  } else {
    throw new ForbiddenError();
  }
  if (!(await tenantPassAuthorityValid(ctx.env.DB, authority, ctx.clock.now())))
    throw new ForbiddenError();
  return authority;
}

/** A tenant session keeps CSRF protection and the usual request-mode selection. */
export const requireTenantSession: MiddlewareHandler<AppBindings> = requireCaller({
  human: true,
  requestMode: true,
});

/** Existing API-key scopes, or a session whose tenant access is checked by the handler. */
export function requireTenantSessionOrApiKey(rule: ScopeRule): MiddlewareHandler<AppBindings> {
  return declareKeyAccess(requireCaller({ scope: rule }), keyAccessOf(rule));
}

/** Org and mode for by-id access (see PassScope). */
export function passScopeOf(c: C): PassScope {
  const auth = authOf(c);
  return {
    orgId: auth.kind === 'api_key' ? auth.orgId : null,
    mode: modeOf(auth),
    principal: auth.kind === 'api_key' ? 'api_key' : 'session',
  };
}

export function assertOrg(c: C, orgId: string): void {
  assertOrgAccess(authOf(c), orgId);
}

export function actorFor(c: C): Actor {
  const actor = actorOf(c.var.auth);
  if (actor.type === 'device') return { type: 'system', id: actor.id };
  return { type: actor.type, id: actor.id };
}

import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { OrgCapability, OrgRole } from '../../../shared/contracts/org-membership.ts';
import {
  type Amr,
  type ApiScope,
  type AuthContext,
  assertOrgAccess,
  modeFromRequest,
  modeOf,
  type Role,
  requireApiKeyOrAdmin,
  requireSession,
  type ScopeSelector,
} from '../../platform/auth.ts';
import { type AppBindings, actorOf } from '../../platform/context.ts';
import { first } from '../../platform/db.ts';
import { reportDenied } from '../../platform/denied.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { requireOrgCapability } from '../orgs/access.ts';
import { tenantOrgUpdatedAt, tenantPassAuthorityValid } from './repo-authority.ts';
import type { PassScope } from './scope.ts';
import type { Actor } from './service.ts';

export type C = Context<AppBindings>;

export const svc = serviceContext;

// Only the endpoint guard can tag the key scope that was checked for this request.
const tenantKeyScopes = new WeakMap<AuthContext, ApiScope>();

/** The exact operation scope already checked by the tenant API-key guard. */
export function tenantKeyScopeOf(auth: AuthContext): ApiScope | undefined {
  return tenantKeyScopes.get(auth);
}

export function authOf(c: C): AuthContext {
  const auth = c.var.auth;
  if (!auth) throw new UnauthenticatedError();
  return auth;
}

/**
 * A credential and exact membership captured before a tenant operation starts.
 * `orgUpdatedAt` is the org's `access_revision` (only status moves it); the name predates the epochs.
 */
export type TenantPassWrite =
  | {
      kind: 'session';
      orgId: string;
      orgUpdatedAt: number;
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
      orgUpdatedAt: number;
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
  const orgUpdatedAt = await tenantOrgUpdatedAt(ctx.env.DB, orgId);
  if (orgUpdatedAt === null) throw new ForbiddenError();
  let authority: TenantPassWrite;
  if (auth.kind === 'session') {
    const membership = await requireOrgCapability(ctx, auth.userId, orgId, capability);
    authority = {
      kind: 'session',
      orgId,
      orgUpdatedAt,
      userId: auth.userId,
      userAccessRevision:
        (
          await first<{ r: number }>(
            ctx.env.DB,
            'SELECT access_revision AS r FROM users WHERE id = ?',
            [auth.userId],
          )
        )?.r ?? 0,
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
    const scope = tenantKeyScopes.get(auth);
    const permitted =
      (capability === 'passes:read' && scope === 'passes:read') ||
      (capability === 'passes:operate' &&
        (scope === 'passes:write' || scope === 'holders:write')) ||
      (capability === 'integrations:read' && scope === 'connections:read') ||
      (capability === 'integrations:manage' && scope === 'connections:write') ||
      (capability === 'templates:read' && scope === 'templates:read') ||
      (capability === 'scanning:read' && scope === 'scans:read') ||
      ((capability === 'messages:read' || capability === 'messages:manage') &&
        scope === 'messages:write');
    if (!scope || !permitted || !auth.scopes.includes(scope)) throw new ForbiddenError();
    authority = {
      kind: 'api_key',
      orgId,
      orgUpdatedAt,
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
export const requireTenantSession: MiddlewareHandler<AppBindings> = createMiddleware(
  async (c, next) =>
    requireSession(c, async () => {
      const auth = authOf(c);
      if (auth.kind !== 'session') throw new UnauthenticatedError();
      c.set('auth', { ...auth, mode: modeFromRequest(c) });
      await next();
    }),
);

/** Existing API-key scopes, or a session whose tenant access is checked by the handler. */
export function requireTenantSessionOrApiKey(
  scope: ScopeSelector | readonly ApiScope[],
): MiddlewareHandler<AppBindings> {
  if (Array.isArray(scope)) {
    return createMiddleware(async (c, next) => {
      const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
      if (!bearer) return requireTenantSession(c, next);
      const auth = await c.var.stores.apiKeys.resolve(bearer);
      if (!auth)
        throw new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
      const selected = scope.find((candidate) => auth.scopes.includes(candidate));
      if (!selected) {
        reportDenied(c, 'MISSING_SCOPE', auth);
        throw new ForbiddenError('The API key lacks a required scope.', 'MISSING_SCOPE');
      }
      const scoped = { ...auth };
      tenantKeyScopes.set(scoped, selected);
      c.set('auth', scoped);
      await next();
    });
  }
  const selector = scope as ScopeSelector;
  const keyGuard = requireApiKeyOrAdmin(selector);
  return createMiddleware(async (c, next) => {
    if (/^Bearer\s+(\S+)$/i.test(c.req.header('authorization') ?? '')) {
      return keyGuard(c, async () => {
        const auth = authOf(c);
        if (auth.kind !== 'api_key') throw new UnauthenticatedError();
        const scoped = { ...auth };
        tenantKeyScopes.set(scoped, typeof selector === 'function' ? selector(c) : selector);
        c.set('auth', scoped);
        await next();
      });
    }
    return requireTenantSession(c, next);
  });
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

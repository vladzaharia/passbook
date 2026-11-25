import type { Context } from 'hono';
import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { enforceFeatures } from '../../platform/feature-guard.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireNotPersonalFor } from '../orgs/personal-guard.ts';
import { authOf, tenantAuthorityOf } from '../passes/http.ts';

type C = Context<AppBindings>;

export function isPlatformAdmin(c: C): boolean {
  const auth = c.var.auth;
  return auth?.kind === 'session' && auth.roles.includes('admin');
}

/**
 * A platform admin acts on any organization. Anyone else needs the capability in that organization:
 * a member of another org is refused, and so is a caller with no org.
 */
export async function requireOrgAccess(
  ctx: ServiceContext,
  c: C,
  orgId: string | null | undefined,
  capability: OrgCapability,
): Promise<void> {
  const auth = authOf(c);
  if (isPlatformAdmin(c)) {
    if (orgId) {
      // A personal org's identity runs and lists are its owner's; renew and revoke-certificate skip this.
      if (auth.kind === 'session') await requireNotPersonalFor(ctx.env.DB, orgId, auth.userId);
      await enforceFeatures(ctx, auth, orgId);
    }
    return;
  }
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  if (!orgId) throw new ForbiddenError();
  await tenantAuthorityOf(ctx, auth, orgId, capability);
}

/** Platform-owned records (no org) are for platform admins. */
export function requirePlatformAdmin(c: C): void {
  if (!isPlatformAdmin(c)) throw new ForbiddenError('Admin access is required.');
}

/** An id-addressed read: another organization's resource is "not found", not "forbidden". */
export async function requireOrgAccessOr404(
  ctx: ServiceContext,
  c: C,
  orgId: string | null | undefined,
  capability: OrgCapability,
  code: string,
): Promise<void> {
  try {
    await requireOrgAccess(ctx, c, orgId, capability);
  } catch (error) {
    if (error instanceof ForbiddenError) throw new NotFoundError('Not found.', code);
    throw error;
  }
}

/** Compromise actions need a Polaris ID sign-in: a magic link or break-glass session is refused. */
export function requireOidcSession(c: C): void {
  const auth = c.var.auth;
  if (auth?.kind !== 'session' || auth.amr !== 'oidc')
    throw new ForbiddenError('Sign in with Polaris ID to do this.', 'OIDC_REQUIRED');
}

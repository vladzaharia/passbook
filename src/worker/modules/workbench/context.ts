import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { entitlementsOf, isEntitled } from '../../platform/entitlements.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sandboxOfUser } from '../developer/repo.ts';
import { orgOfCaller } from '../developer/request-log-service.ts';
import { getOrgAccess } from '../orgs/access.ts';

const notFound = () => new NotFoundError('Context not found.', 'WORKBENCH_CONTEXT_NOT_FOUND');

/** An organization the Workbench may open in Test: one that is not a sandbox and whose plan has Test passes. */
export async function testCapableOrg(
  ctx: ServiceContext,
  userId: string,
  orgId: string,
): Promise<{ capabilities: readonly OrgCapability[] } | null> {
  const access = await getOrgAccess(ctx, userId, orgId);
  if (!access || access.testOnly || !access.capabilities.includes('org:read')) return null;
  return isEntitled(await entitlementsOf(ctx, orgId), 'passes.test') ? access : null;
}

/**
 * The organization a Workbench read looks in. With no `orgId` it is the caller's own sandbox. A named one is the
 * caller's sandbox, the org a try token belongs to, or an organization the person may use Test in: anything else
 * is not found, so no org is learned from its id.
 */
export async function contextOrg(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string | undefined,
): Promise<string> {
  if (orgId === undefined) return orgOfCaller(ctx, auth);
  if (auth?.kind === 'api_key') {
    if (auth.via === 'try' && auth.orgId === orgId) return orgId;
    throw notFound();
  }
  if (auth?.kind !== 'session') return orgOfCaller(ctx, auth);
  if ((await sandboxOfUser(ctx.env.DB, auth.userId))?.org_id === orgId) return orgId;
  if (!(await testCapableOrg(ctx, auth.userId, orgId))) throw notFound();
  return orgId;
}

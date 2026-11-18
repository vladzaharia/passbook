import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { type C, tenantAuthorityOf } from '../passes/http.ts';
import { tagTarget } from './repo-tags.ts';

export const tagNotFound = () => new NotFoundError('Tag not found.', 'TAG_NOT_FOUND');
export const passNotFound = () => new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
export const orgNotFound = () => new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');

/** A tenant session with this capability in the org; an org the user is not in is a 404. */
export async function actingIn(
  c: C,
  orgId: string,
  capability: Extract<OrgCapability, 'passes:read' | 'passes:operate'>,
  notFound: () => Error,
) {
  const ctx = serviceContext(c);
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  if (!(await getOrgAccess(ctx, auth.userId, orgId))) throw notFound();
  return { ctx, authority: await tenantAuthorityOf(ctx, auth, orgId, capability) };
}

/** A tag's org, before any authority exists for it. */
export async function tagOrg(c: C, id: string): Promise<string> {
  const tag = await tagTarget(serviceContext(c).env.DB, id);
  if (!tag) throw tagNotFound();
  return tag.orgId;
}

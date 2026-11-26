import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { type C, type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { tenantPrincipal } from '../passes/repo-authority.ts';
import { passInTenantLimits } from './repo-tag-bindings.ts';
import { tagTarget } from './repo-tags.ts';

/** A console session only (the route takes no key): what `requireTenantSession` was. */
export const CONSOLE = { human: true, requestMode: true } as const;

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

/**
 * Like `actingIn`, for a route that also takes a key (`nfc:read` or `nfc:write`, per the route's `auth`). A key
 * of another org, and a platform key with no org, get the same 404. `limited` is a key limited to templates or
 * styles: it reaches passes of those templates only, and never a user-scope tag.
 */
export async function actingKeyOrSession(
  c: C,
  orgId: string,
  capability: Extract<OrgCapability, 'passes:read' | 'passes:operate'>,
  notFound: () => Error,
) {
  const auth = c.var.auth;
  if (auth?.kind !== 'api_key')
    return { ...(await actingIn(c, orgId, capability, notFound)), limited: false };
  if (auth.orgId !== orgId) throw notFound();
  const ctx = serviceContext(c);
  return {
    ctx,
    authority: await tenantAuthorityOf(ctx, auth, orgId, capability),
    limited: auth.limited === true,
  };
}

/** A key reaches the pass: it is in the key's org and mode, and inside its template limits. A session passes. */
export async function keyReachesPass(
  c: C,
  authority: TenantPassWrite,
  passId: string,
): Promise<boolean> {
  if (authority.kind !== 'api_key') return true;
  const ctx = serviceContext(c);
  return passInTenantLimits(ctx.env.DB, tenantPrincipal(authority), ctx.clock.now(), passId);
}

/** A key limited to templates takes spare tags and pass-scope bindings only. */
export const limitedKeyRefusal = () =>
  new ForbiddenError(
    'A key limited to templates assigns spare tags to a pass only.',
    'TAG_KEY_LIMITED',
  );

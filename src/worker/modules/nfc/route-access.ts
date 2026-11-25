import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import { authorityPredicate, tenantFilter } from '../../platform/authority-read.ts';
import { first } from '../../platform/db.ts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { type C, type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { tenantPrincipal } from '../passes/repo-authority.ts';
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
  const p = authorityPredicate(tenantPrincipal(authority), {
    scope: 'org_mode',
    now: ctx.clock.now(),
  });
  const row = await first<{ id: string }>(
    ctx.env.DB,
    `WITH ${p.ctes} SELECT p.id FROM passes p WHERE EXISTS (SELECT 1 FROM actor_ok) AND p.id = ? AND ${tenantFilter('p', 'passes')}`,
    [...p.params, passId],
  );
  return row !== null;
}

/** A key limited to templates takes spare tags and pass-scope bindings only. */
export const limitedKeyRefusal = () =>
  new ForbiddenError(
    'A key limited to templates assigns spare tags to a pass only.',
    'TAG_KEY_LIMITED',
  );

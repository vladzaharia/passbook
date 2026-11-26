import { type AuthContext, assertOrgAccess } from '../../platform/auth.ts';
import { assertWorkbenchOrg } from '../../platform/auth-workbench.ts';
import { ForbiddenError, NotFoundError, orgTestOnly } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireOrgCapability } from '../orgs/access.ts';
import { tenantAuthorityOf } from './http.ts';
import type { Pass } from './repo-map.ts';
import { getPass } from './repo-read-pass.ts';
import { assertWritableMode, type PassScope, type ScopeArg } from './scope.ts';

/** Reads a pass for a change: missing, out of org, or (for API keys and sessions) the other mode fails. */
export async function getPassForWrite(db: D1Database, id: string, scope: ScopeArg): Promise<Pass> {
  return writablePass(await getPass(db, id, scope), scope);
}

/** `getPassForWrite` for a row the caller already read. */
export function writablePass(pass: Pass | null, scope: ScopeArg): Pass {
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  assertWritableMode(scope, pass.mode);
  return pass;
}

export async function requireTenantPassRead(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
): Promise<void> {
  if (auth.kind === 'session') {
    // A Workbench token reads its own org only; a sandbox has no Live to read.
    assertWorkbenchOrg(auth, orgId);
    const membership = await requireOrgCapability(ctx, auth.userId, orgId, 'passes:read');
    if (auth.mode === 'live' && membership.testOnly) throw orgTestOnly();
  } else if (auth.kind === 'api_key') {
    assertOrgAccess(auth, orgId);
  } else {
    throw new ForbiddenError();
  }
}

/** Pin follow-on reads to the same authorized tenant. */
export async function tenantPassForRead(
  ctx: ServiceContext,
  auth: AuthContext,
  id: string,
  scope: PassScope,
) {
  const pass = await getPass(ctx.env.DB, id, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  await requireTenantPassRead(ctx, auth, pass.orgId);
  return { pass, scope: { ...scope, orgId: pass.orgId } };
}

/** Resolve the tenant before a direct write and pin subsequent reads to that organization. */
export async function tenantPassForWrite(
  ctx: ServiceContext,
  auth: AuthContext,
  id: string,
  scope: PassScope,
) {
  const pass = await getPass(ctx.env.DB, id, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const authority = await tenantAuthorityOf(ctx, auth, pass.orgId, 'passes:operate');
  assertWritableMode(scope, pass.mode);
  return { pass, authority, scope: { ...scope, orgId: pass.orgId } };
}

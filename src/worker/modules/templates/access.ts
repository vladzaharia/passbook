import type { AuthContext } from '../../platform/auth.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { hasTemplateAuthority } from './repo-authority.ts';

export type PlatformSessionAuthority = { kind: 'platform'; userId: string; sessionId: string };
export type TemplateAuthority =
  | Extract<TenantPassWrite, { kind: 'session' }>
  | PlatformSessionAuthority;

/** Authorize the actual destination organization, never a caller-supplied replacement for it. */
export async function authorizeTemplateWrite(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string | null,
  capability: 'templates:author' | 'templates:review' | 'templates:publish',
): Promise<TemplateAuthority> {
  if (!auth) throw new UnauthenticatedError();
  if (auth.kind !== 'session') throw new ForbiddenError();
  if (orgId !== null) {
    const authority = await tenantAuthorityOf(ctx, auth, orgId, capability);
    if (authority.kind !== 'session') throw new ForbiddenError();
    return authority;
  }
  if (!auth.roles.includes('admin')) throw new ForbiddenError();
  const authority: PlatformSessionAuthority = {
    kind: 'platform',
    userId: auth.userId,
    sessionId: auth.sessionId,
  };
  await assertTemplateAuthority(ctx, authority);
  return authority;
}

/** Recheck a captured grant immediately before a non-D1 side effect. */
export async function assertTemplateAuthority(
  ctx: ServiceContext,
  authority: TemplateAuthority,
  deferred = false,
): Promise<void> {
  if (!(await hasTemplateAuthority(ctx.env.DB, authority, ctx.clock.now(), deferred)))
    throw new ForbiddenError();
}

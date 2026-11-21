import type { Role } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { myMemberships } from '../orgs/repo-members.ts';
import { homeFor, safeNext } from './next.ts';

/** `homeFor`, with org members (who hold console roles) landing on the console, not My passes. */
export async function landingFor(
  ctx: ServiceContext,
  userId: string,
  roles: readonly Role[],
  next?: string | null,
  /** A Polaris ID sign-in: with the admin group required, a member without it lands on My passes. */
  oidc = false,
): Promise<string> {
  if (safeNext(next) || roles.includes('admin')) return homeFor(roles, next);
  if (oidc && ctx.env.OIDC_CONSOLE_GROUP_REQUIRED === 'true' && !roles.includes('console'))
    return homeFor(roles, next);
  const memberships = await myMemberships(ctx.env.DB, userId);
  return memberships.length > 0 ? '/admin' : homeFor(roles, next);
}

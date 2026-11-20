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
): Promise<string> {
  if (safeNext(next) || roles.includes('admin')) return homeFor(roles, next);
  const memberships = await myMemberships(ctx.env.DB, userId);
  return memberships.length > 0 ? '/admin' : homeFor(roles, next);
}

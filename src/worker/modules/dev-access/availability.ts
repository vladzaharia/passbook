import { entitlementsOf } from '../../platform/entitlements.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { idpClient, idpConfigured } from '../idp/client.ts';

/** The org's `members.developers` allowance: a count, null for no limit, 0 for none. */
export async function developerLimit(ctx: ServiceContext, orgId: string): Promise<number | null> {
  const value = (await entitlementsOf(ctx, orgId))['members.developers'];
  return value === null ? null : typeof value === 'number' ? value : 0;
}

/** The groups an invitation puts a person in: the developer group sign-in reads, and the console group for a paired membership. */
export type IdpNeed = 'console' | 'developer';

/** Polaris ID is reachable, healthy, live (not dry run), not frozen, and each needed group exists and is the one sign-in reads. */
export async function idpReady(
  ctx: ServiceContext,
  needs: readonly IdpNeed[] = ['developer'],
): Promise<boolean> {
  if (!idpConfigured(ctx.env)) return false;
  try {
    const health = await idpClient(ctx.env).health();
    return (
      health.ok &&
      health.unsafe.length === 0 &&
      health.mode === 'live' &&
      !health.frozen &&
      (!needs.includes('developer') ||
        (Boolean(health.groups.developer) &&
          health.groups.developer === ctx.env.OIDC_DEVELOPER_GROUP)) &&
      (!needs.includes('console') ||
        (Boolean(health.groups.console) && health.groups.console === ctx.env.OIDC_ADMIN_GROUP))
    );
  } catch {
    ctx.log.warn('developer_access.idp_unhealthy', { code: 'IDP_UNAVAILABLE' });
    return false;
  }
}

export async function assertIdpReady(
  ctx: ServiceContext,
  needs: readonly IdpNeed[] = ['developer'],
): Promise<void> {
  if (!(await idpReady(ctx, needs)))
    throw new UnavailableError(
      'Polaris ID is not reachable. Try again in a few minutes.',
      'IDP_UNAVAILABLE',
    );
}

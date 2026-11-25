import { entitlementsOf } from '../../platform/entitlements.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { idpClient, idpConfigured } from '../idp/client.ts';

/** The org's `members.developers` allowance: a count, null for no limit, 0 for none. */
export async function developerLimit(ctx: ServiceContext, orgId: string): Promise<number | null> {
  const value = (await entitlementsOf(ctx, orgId))['members.developers'];
  return value === null ? null : typeof value === 'number' ? value : 0;
}

/** Polaris ID is reachable, healthy, live (not dry run), not frozen, and the developer group is the one sign-in reads. */
export async function idpReady(ctx: ServiceContext): Promise<boolean> {
  if (!idpConfigured(ctx.env)) return false;
  try {
    const health = await idpClient(ctx.env).health();
    return (
      health.ok &&
      health.unsafe.length === 0 &&
      health.mode === 'live' &&
      !health.frozen &&
      Boolean(health.groups.developer) &&
      health.groups.developer === ctx.env.OIDC_DEVELOPER_GROUP
    );
  } catch {
    ctx.log.warn('developer_access.idp_unhealthy', { code: 'IDP_UNAVAILABLE' });
    return false;
  }
}

export async function assertIdpReady(ctx: ServiceContext): Promise<void> {
  if (!(await idpReady(ctx)))
    throw new UnavailableError(
      'Polaris ID is not reachable. Try again in a few minutes.',
      'IDP_UNAVAILABLE',
    );
}

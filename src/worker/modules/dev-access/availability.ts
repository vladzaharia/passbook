import { entitlementsOf } from '../../platform/entitlements.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { idpClient, idpConfigured } from '../idp/client.ts';

/** The org's `members.developers` allowance: a count, null for no limit, 0 for none. */
export async function developerLimit(ctx: ServiceContext, orgId: string): Promise<number | null> {
  const value = (await entitlementsOf(ctx, orgId))['members.developers'];
  return value === null ? null : typeof value === 'number' ? value : 0;
}

/** Polaris ID is reachable, safe to write and the developer group is configured. */
export async function idpReady(ctx: ServiceContext): Promise<boolean> {
  const env = ctx.env as { IDP?: unknown };
  if (!idpConfigured(env)) return false;
  try {
    const health = await idpClient(env).health();
    return health.ok && health.unsafe.length === 0 && !!health.groups.developer;
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

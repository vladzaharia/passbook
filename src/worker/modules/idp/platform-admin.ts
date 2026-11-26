import type { ServiceContext } from '../../platform/service-context.ts';
import { idpClient, idpConfigured } from './client.ts';
import { isPlatformAdmin } from './desired.ts';
import { idpCodeOf } from './errors.ts';
import { subjectsOfUser } from './repo-sources.ts';

/**
 * Whether a refusal for platform admins applies to this user: their last sign-in named admin, or Polaris ID says any
 * of their accounts is an admin right now (they may have been added and not signed in since). An answer that cannot
 * be had counts as admin; an account Polaris ID does not know cannot be one.
 */
export async function isLiveAdmin(
  ctx: ServiceContext,
  userId: string,
  lastRoles: string,
): Promise<boolean> {
  if (isPlatformAdmin(lastRoles)) return true;
  if (!idpConfigured(ctx.env)) return false;
  const rpc = idpClient(ctx.env, ctx.log);
  for (const subject of await subjectsOfUser(ctx.env.DB, userId)) {
    try {
      const found = await rpc.lookup(subject);
      if (found.isAdmin || found.roles.includes('platform_admin')) return true;
    } catch (error) {
      if (idpCodeOf(error) !== 'IDP_NOT_FOUND') return true;
    }
  }
  return false;
}

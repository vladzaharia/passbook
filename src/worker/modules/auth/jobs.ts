import type { ServiceContext } from '../../platform/service-context.ts';
import { purgeExpired } from './repo.ts';

/** Daily retention for magic links, OIDC flows, expired sessions and counters. */
export async function dailyAuth(ctx: ServiceContext): Promise<void> {
  const removed = await purgeExpired(ctx.env.DB, ctx.clock.now());
  ctx.log.info('auth.retention', removed);
}

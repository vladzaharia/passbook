import type { ServiceContext } from '../../platform/service-context.ts';
import { idleSandboxOrgs } from './repo.ts';
import { closeSandbox } from './repo-grants.ts';

/** A sandbox with no activity for this long closes. */
export const SANDBOX_IDLE_MS = 90 * 86_400_000;
const BATCH = 50;

/**
 * Daily hook `developer.idle_close`: closes sandboxes idle for 90 days. A closed org stays read-only for its
 * export window and is then purged like any closed org. One failure never blocks the rest.
 */
export async function dailyDeveloperSandbox(ctx: ServiceContext): Promise<void> {
  const idle = await idleSandboxOrgs(ctx.env.DB, ctx.clock.now() - SANDBOX_IDLE_MS, BATCH);
  let closed = 0;
  for (const orgId of idle) {
    try {
      if (await closeSandbox(ctx, orgId)) closed++;
    } catch (error) {
      ctx.log.warn('developer.idle_close_failed', { orgId, code: 'SANDBOX_CLOSE_FAILED', error });
    }
  }
  if (closed > 0) ctx.log.info('developer.sandboxes_closed', { count: closed });
}

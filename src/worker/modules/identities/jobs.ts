import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { checkIdentityById, runDailyIdentityChecks } from './check.ts';

/** Re-verifies one identity. A deleted identity is not an error: there is nothing to retry. */
export async function handleIdentityCheck(
  job: JobOf<'identity.check'>,
  ctx: ServiceContext,
): Promise<void> {
  const result = await checkIdentityById(ctx, job.identityId);
  if (!result) ctx.log.info('identity.check_skipped', { identityId: job.identityId });
}

export async function dailyIdentities(ctx: ServiceContext): Promise<void> {
  await runDailyIdentityChecks(ctx);
}

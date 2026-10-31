import type { ServiceContext } from '../../platform/service-context.ts';
import { runDailyIdentityChecks } from './check.ts';

export async function dailyIdentities(ctx: ServiceContext): Promise<void> {
  await runDailyIdentityChecks(ctx);
}

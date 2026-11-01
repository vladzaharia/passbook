import type { ServiceContext } from '../../platform/service-context.ts';
import { runDailyApnsProbes } from './apns-probe.ts';
import { runDailyIdentityChecks } from './check.ts';

export async function dailyIdentities(ctx: ServiceContext): Promise<void> {
  await runDailyIdentityChecks(ctx);
}

export async function dailyApnsProbe(ctx: ServiceContext): Promise<void> {
  await runDailyApnsProbes(ctx);
}

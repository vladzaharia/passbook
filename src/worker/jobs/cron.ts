import { dailyApple } from '../modules/apple/jobs.ts';
import { dailyAudit } from '../modules/audit/jobs.ts';
import { dailyAuth } from '../modules/auth/jobs.ts';
import { dailyConnections, reconcileConnections } from '../modules/connections/jobs.ts';
import { dailyDelivery, sweepDelivery } from '../modules/delivery/jobs.ts';
import { dailyApnsProbe, dailyIdentities } from '../modules/identities/jobs.ts';
import { dailyPasses } from '../modules/passes/jobs.ts';
import { recordCronRun } from '../modules/status/cron.ts';
import type { AppEnv } from '../platform/env.ts';
import { createServiceContext, type ServiceContext } from '../platform/service-context.ts';

export type CronHook = (ctx: ServiceContext) => Promise<void>;

export const MINUTE_CRON = '* * * * *';
export const DAILY_CRON = '17 3 * * *';

/** Hooks run in parallel and independently; one failing never blocks the others. */
export const CRON_HOOKS: Record<string, { name: string; run: CronHook }[]> = {
  [MINUTE_CRON]: [
    { name: 'delivery.sweep', run: sweepDelivery },
    { name: 'connections.schedule', run: reconcileConnections },
  ],
  [DAILY_CRON]: [
    { name: 'passes.retention', run: dailyPasses },
    { name: 'connections.retention', run: dailyConnections },
    { name: 'delivery.retention', run: dailyDelivery },
    { name: 'auth.retention', run: dailyAuth },
    { name: 'audit.retention', run: dailyAudit },
    { name: 'apple.retention', run: dailyApple },
    { name: 'identities.expiry', run: dailyIdentities },
    { name: 'identities.apns_probe', run: dailyApnsProbe },
  ],
};

export async function handleScheduled(
  controller: ScheduledController,
  env: AppEnv,
  ctx: ExecutionContext,
): Promise<void> {
  const hooks = CRON_HOOKS[controller.cron] ?? [];
  const base = createServiceContext(env, { ctx, base: { cron: controller.cron } });
  const results = await Promise.allSettled(
    hooks.map((hook) =>
      hook.run(
        createServiceContext(env, { ctx, base: { cron: controller.cron, hook: hook.name } }),
      ),
    ),
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected')
      base.log.error('cron.hook_failed', { hook: hooks[i]?.name, error: result.reason });
  });
  if (controller.cron === MINUTE_CRON) {
    try {
      await recordCronRun(base, 'minute');
    } catch (error) {
      base.log.error('cron.record_failed', { error });
    }
  }
}

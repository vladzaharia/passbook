import { dailyApple } from '../modules/apple/jobs.ts';
import { dailyAudit } from '../modules/audit/jobs.ts';
import { dailyAuth } from '../modules/auth/jobs.ts';
import { startDueBroadcasts } from '../modules/broadcasts/start.ts';
import { dailyConnections, reconcileConnections } from '../modules/connections/jobs.ts';
import { dailyDelivery, sweepDelivery } from '../modules/delivery/jobs.ts';
import { dailyEvents } from '../modules/events/jobs.ts';
import { dailyApnsProbe, dailyIdentities } from '../modules/identities/jobs.ts';
import { dailyPasses } from '../modules/passes/jobs.ts';
import { reissueStalePasses } from '../modules/passes/stale-reissue.ts';
import { recordCronRun } from '../modules/status/cron.ts';
import { syncBakedOnDeploy } from '../modules/templates/jobs.ts';
import type { AppEnv } from '../platform/env.ts';
import { createServiceContext, type ServiceContext } from '../platform/service-context.ts';
import { CRON_QUERY_BUDGET, countQueries } from './query-counter.ts';

export type CronHook = (ctx: ServiceContext) => Promise<void>;

export const MINUTE_CRON = '* * * * *';
export const DAILY_CRON = '17 3 * * *';

/** Hooks run independently; one failing never blocks the others. Daily hooks share a query budget. */
export const CRON_HOOKS: Record<string, { name: string; run: CronHook }[]> = {
  [MINUTE_CRON]: [
    { name: 'delivery.sweep', run: sweepDelivery },
    { name: 'connections.schedule', run: reconcileConnections },
    { name: 'templates.sync', run: syncBakedOnDeploy },
    { name: 'passes.stale_reissue', run: reissueStalePasses },
    { name: 'broadcasts.start', run: startDueBroadcasts },
  ],
  [DAILY_CRON]: [
    { name: 'passes.retention', run: dailyPasses },
    { name: 'connections.retention', run: dailyConnections },
    { name: 'delivery.retention', run: dailyDelivery },
    { name: 'auth.retention', run: dailyAuth },
    { name: 'audit.retention', run: dailyAudit },
    { name: 'events.retention', run: dailyEvents },
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
  const hookCtx = (env: AppEnv, hook: string) =>
    createServiceContext(env, { ctx, base: { cron: controller.cron, hook } });
  const failed = (hook: string, error: unknown) =>
    base.log.error('cron.hook_failed', { hook, code: 'CRON_HOOK_FAILED', error });
  if (controller.cron === DAILY_CRON) {
    // Sequential under one query budget: a hook that would start past it is skipped until tomorrow.
    const counter = countQueries(env);
    for (const hook of hooks) {
      if (counter.count() >= CRON_QUERY_BUDGET) {
        base.log.warn('cron.budget_skipped', {
          hook: hook.name,
          code: 'CRON_BUDGET',
          queries: counter.count(),
        });
        continue;
      }
      try {
        await hook.run(hookCtx(counter.env, hook.name));
      } catch (error) {
        failed(hook.name, error);
      }
    }
  } else {
    const results = await Promise.allSettled(
      hooks.map((hook) => hook.run(hookCtx(env, hook.name))),
    );
    results.forEach((result, i) => {
      if (result.status === 'rejected') failed(hooks[i]?.name ?? 'unknown', result.reason);
    });
  }
  if (controller.cron === MINUTE_CRON) {
    try {
      await recordCronRun(base, 'minute');
    } catch (error) {
      base.log.error('cron.record_failed', { code: 'CRON_RECORD_FAILED', error });
    }
  }
}

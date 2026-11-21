import type { ServiceContext } from '../../platform/service-context.ts';
import { runRotationAlerts } from './alerts.ts';
import { dueRotations } from './repo-provision.ts';
import { startRotation } from './run-start.ts';

/** A day's worth of new runs at most; the rest wait for tomorrow, as the provisioner's budget does. */
const BATCH = 25;

/** Starts a rotate run for every due auto identity with no open run. */
export async function planRotations(ctx: ServiceContext): Promise<number> {
  let started = 0;
  for (const due of await dueRotations(ctx.env.DB, ctx.clock.now(), BATCH)) {
    try {
      const run = await startRotation(ctx, { identityId: due.id, createdBy: null });
      if (run.created) started += 1;
    } catch (error) {
      ctx.log.error('identity.rotation_start_failed', {
        identityId: due.id,
        code: 'IDENTITY_ROTATION_START_FAILED',
        error,
      });
    }
  }
  if (started > 0) ctx.log.info('identity.rotation_planned', { started });
  return started;
}

/** Daily cron: start due rotations, then alert on the ones that did not finish in time. */
export async function dailyRotationPlan(ctx: ServiceContext): Promise<void> {
  await planRotations(ctx);
  await runRotationAlerts(ctx);
}

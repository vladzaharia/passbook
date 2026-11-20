import { type EntitlementValues, entitlementTransition } from '../../../shared/channels.ts';
import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgRefusal } from './apply-run.ts';
import { startApplyInstance } from './apply-start.ts';
import { getPolicy } from './repo.ts';
import { entitlementRunSince, passScopes, writeEntitlementRun } from './repo-entitlement-runs.ts';
import { pendingRun } from './repo-runs.ts';

/**
 * Called after an org's entitlements changed (the platform write). Queues the apply runs the transition
 * asks for: stop offering or offer again, never a retirement or a new code. A failed send is logged: the
 * channels already read the new plan, only the passes' journal waits.
 */
export async function onEntitlementsChanged(
  ctx: ServiceContext,
  orgId: string,
  before: EntitlementValues,
  after: EntitlementValues,
  requestedBy: string,
): Promise<void> {
  for (const effect of entitlementTransition(before, after)) {
    try {
      await ctx.env.JOBS.send({
        kind: 'channel.entitlement',
        orgId,
        blockedBefore: effect.blockedBefore,
        requestedBy,
        at: ctx.clock.now(),
      });
    } catch (error) {
      ctx.log.error('channels.entitlement_queue_failed', {
        orgId,
        code: 'CHANNEL_ENTITLEMENT_QUEUE',
        error,
      });
    }
  }
}

/** One apply run per (mode, template) with live passes, each from the plan as it was. */
export async function handleEntitlementApply(
  job: JobOf<'channel.entitlement'>,
  ctx: ServiceContext,
): Promise<void> {
  const db = ctx.env.DB;
  for (const { mode, templateId } of await passScopes(db, job.orgId)) {
    if (await entitlementRunSince(db, job.orgId, mode, templateId, job.at)) continue;
    const stored = await getPolicy(db, job.orgId, mode, templateId);
    const runId = ctx.ids.id();
    try {
      await writeEntitlementRun(ctx, {
        orgId: job.orgId,
        mode,
        templateId,
        runId,
        blockedBefore: job.blockedBefore,
        from: stored?.channels ?? {},
        fromRevision: stored?.revision ?? 0,
        requestedBy: job.requestedBy,
      });
    } catch (error) {
      // A suspended or closed org has no apply: its channels read the plan live.
      if (isOrgRefusal(error)) {
        ctx.log.info('channels.entitlement_skipped', { orgId: job.orgId });
        return;
      }
      throw error;
    }
    // Only the call that opened the run starts its instance; one that joined a pending run has it.
    const pending = await pendingRun(db, job.orgId, mode, templateId);
    if (pending?.id === runId) await startApplyInstance(ctx, runId);
  }
}

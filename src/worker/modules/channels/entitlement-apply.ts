import {
  blockedByEntitlement,
  type EntitlementValues,
  entitlementTransition,
} from '../../../shared/channels.ts';
import { CHANNELS, type Channel } from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { valuesInMode } from '../../../shared/contracts/entitlements/test-waivable.ts';
import type { JobOf } from '../../jobs/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgRefusal } from './apply-run.ts';
import { startApplyInstance } from './apply-start.ts';
import { getPolicy } from './repo.ts';
import {
  passScopes,
  revisionCovered,
  writeEntitlementTransition,
} from './repo-entitlement-runs.ts';
import { pendingRun } from './repo-runs.ts';

const SEND_ATTEMPTS = 3;

/** Only what a plan can block in `mode`: in Test, the waived features (paper, nfc) never block. */
function blockableIn(mode: Mode, channels: readonly Channel[]): Channel[] {
  const blocked = blockedByEntitlement(valuesInMode({}, mode));
  return channels.filter((c) => blocked[c] !== undefined);
}

/**
 * Called after an org's entitlements changed (the platform write, which made entitlement `revision`).
 * Queues the apply runs the transition asks for: stop offering or offer again, never a retirement or a new
 * code. Three failed sends are logged with the revision: the channels already read the new plan, only the
 * passes' journal waits.
 */
export async function onEntitlementsChanged(
  ctx: ServiceContext,
  orgId: string,
  before: EntitlementValues,
  after: EntitlementValues,
  requestedBy: string,
  revision: number,
  full = false,
): Promise<void> {
  // A full reconcile knows only the plan now: the plan is the same on both sides, so only flips the run
  // already knows (template and pass changes) are journaled. Plan blocks never retire, so the actions are the same.
  const now = CHANNELS.filter((c) => blockedByEntitlement(after)[c] !== undefined);
  const effects = full
    ? [{ blockedBefore: now, blockedAfter: now }]
    : entitlementTransition(before, after);
  for (const effect of effects) {
    const job = {
      kind: 'channel.entitlement',
      orgId,
      revision,
      blockedBefore: effect.blockedBefore,
      blockedAfter: effect.blockedAfter,
      ...(full ? { full: true } : {}),
      requestedBy,
    } as const;
    // The write is committed and a repeated PUT is a no-op, so a lost send would never converge: try a few times.
    for (let attempt = 1; ; attempt++) {
      try {
        await ctx.env.JOBS.send(job);
        break;
      } catch (error) {
        if (attempt < SEND_ATTEMPTS) continue;
        ctx.log.error('channels.entitlement_queue_failed', {
          orgId,
          revision,
          code: 'CHANNEL_ENTITLEMENT_QUEUE',
          error,
        });
        break;
      }
    }
  }
}

/**
 * One apply run per (mode, template) with live passes, covering this revision with the plan as it was and
 * as it became, as the mode sees it: a Test run still covers the revision when its waived channels drop
 * out. Keyed on the revision: jobs may arrive in any order and more than once, and each revision is
 * journaled once. A job whose neighbour has not arrived yet throws, and the queue retries it.
 */
export async function handleEntitlementApply(
  job: JobOf<'channel.entitlement'>,
  ctx: ServiceContext,
): Promise<void> {
  const db = ctx.env.DB;
  for (const { mode, templateId } of await passScopes(db, job.orgId)) {
    if (await revisionCovered(db, job.orgId, mode, templateId, job.revision)) continue;
    const stored = await getPolicy(db, job.orgId, mode, templateId);
    const pending = await pendingRun(db, job.orgId, mode, templateId);
    const runId = ctx.ids.id();
    let written: boolean;
    try {
      written = await writeEntitlementTransition(
        ctx,
        {
          orgId: job.orgId,
          mode,
          templateId,
          revision: job.revision,
          blockedBefore: blockableIn(mode, job.blockedBefore),
          blockedAfter: blockableIn(mode, job.blockedAfter),
          ...(job.full ? { full: true } : {}),
          requestedBy: job.requestedBy,
        },
        pending && {
          id: pending.id,
          fromRev: pending.fromRev,
          toRev: pending.toRev,
          fromBlocked: pending.fromBlocked,
          toBlocked: pending.toBlocked,
        },
        { runId, from: stored?.channels ?? {}, fromRevision: stored?.revision ?? 0 },
      );
    } catch (error) {
      // A suspended or closed org has no apply: its channels read the plan live.
      if (isOrgRefusal(error)) {
        ctx.log.info('channels.entitlement_skipped', { orgId: job.orgId });
        return;
      }
      throw error;
    }
    // A gap, or a run that moved under the write: nothing recorded, so the queue retries this job.
    if (!written || !(await revisionCovered(db, job.orgId, mode, templateId, job.revision)))
      throw new AppError(
        'CHANNEL_ENTITLEMENT_RETRY',
        503,
        'The previous plan change is not recorded yet.',
      );
    // Only the call that opened the run starts its instance; one that joined a pending run has it.
    const now = await pendingRun(db, job.orgId, mode, templateId);
    if (now?.id === runId) await startApplyInstance(ctx, runId);
  }
}

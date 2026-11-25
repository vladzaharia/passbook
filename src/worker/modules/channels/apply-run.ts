import { blockedByEntitlement, templateDefault } from '../../../shared/channels.ts';
import { CHANNELS, type Channel } from '../../../shared/contracts/channels.ts';
import { entitlementsOf } from '../../platform/entitlements.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { journal } from './apply-journal.ts';
import { getPolicy, type Policy, templateDefaultsOf } from './repo.ts';
import { writeDrop, writeFail, writeFinish, writeStart, writeTouch } from './repo-apply-write.ts';
import { mayPublish } from './repo-replace.ts';
import type { ApplyRun } from './repo-runs.ts';
import { getRun, priorRun, REPLACE_PRINCIPAL_REVOKED, rotating, runningRun } from './repo-runs.ts';
import { blockingWindow, openWindows, windowsCloseAt } from './windows.ts';

export type StartResult =
  | 'started'
  | 'blocked'
  | 'moved'
  | 'dropped'
  | 'skipped'
  | 'inactive'
  | 'stalled';

/** A running run that has written nothing for this long is stalled. */
export const STALLED_AFTER_MS = 10 * 60_000;
export const PREDECESSOR_STALLED = 'CHANNEL_APPLY_PREDECESSOR_STALLED';
export const ORG_INACTIVE = 'CHANNEL_APPLY_ORG_INACTIVE';
export const WINDOW_TIMEOUT = 'CHANNEL_REPLACE_WINDOW_TIMEOUT';
/** A sleeping run wakes this often to show life: status reads a silent run as stalled after 10 minutes. */
export const GATE_ROUND_MS = 5 * 60_000;
export const isOrgRefusal = (error: unknown): boolean =>
  error instanceof AppError && error.code === 'ORG_ACCESS_CHANGED';

const same = (a: Policy, b: Policy, defaults: Policy): boolean =>
  CHANNELS.every((c) => {
    const d = defaults[c] ?? templateDefault(c);
    return (a[c] ?? d) === (b[c] ?? d);
  });

/**
 * Where the run's change really begins. A run whose predecessor failed also owes the failed run's
 * range (it was applied in part), so it begins where that run began, and is never dropped as a no-op.
 * An entitlement run's `fromBlocked` follows the same rule: the oldest one recorded.
 */
export async function effectiveFrom(
  ctx: ServiceContext,
  run: ApplyRun,
): Promise<{ from: Policy; fromBlocked: Channel[] | null; viaFailed: boolean }> {
  let from = run.from;
  let fromBlocked = run.fromBlocked;
  let viaFailed = false;
  let cur = run;
  for (let hops = 0; hops < 20; hops++) {
    const prior = await priorRun(ctx.env.DB, cur);
    if (prior?.state !== 'failed') break;
    from = prior.from;
    fromBlocked = prior.fromBlocked ?? fromBlocked;
    viaFailed = true;
    cur = prior;
  }
  return { from, fromBlocked, viaFailed };
}

/** The channels the org's plan blocks now. */
async function blockedNow(ctx: ServiceContext, orgId: string): Promise<Channel[]> {
  const blocked = blockedByEntitlement(await entitlementsOf(ctx, orgId));
  return CHANNELS.filter((c) => blocked[c] !== undefined);
}

/** The debounce state of a run: whether it still waits, when it is due, and the time the answer was read. */
export async function dueOf(
  ctx: ServiceContext,
  runId: string,
): Promise<{ state: string; dueAt: number; now: number }> {
  const run = await getRun(ctx.env.DB, runId);
  return { state: run?.state ?? 'missing', dueAt: run?.dueAt ?? 0, now: ctx.clock.now() };
}

/**
 * Takes the run from pending to running with the policy as it stands, or drops it when the policy is
 * back where the run began. Safe to repeat: a run that is already running reports started.
 */
export async function startOne(ctx: ServiceContext, runId: string): Promise<StartResult> {
  const run = await getRun(ctx.env.DB, runId);
  if (!run) return 'skipped';
  if (run.state === 'running') return 'started';
  if (run.state !== 'pending') return 'skipped';
  const stored = await getPolicy(ctx.env.DB, run.orgId, run.mode, run.templateId);
  const to = stored?.channels ?? {};
  const begin = await effectiveFrom(ctx, run);
  try {
    // The policy is back where the run began, and so is the plan: nothing to apply.
    if (
      !begin.viaFailed &&
      !run.reconcileAll &&
      same(
        begin.from,
        to,
        await templateDefaultsOf(ctx.env.DB, run.templateId, run.orgId, run.mode),
      ) &&
      (begin.fromBlocked === null ||
        begin.fromBlocked.join() === (run.toBlocked ?? (await blockedNow(ctx, run.orgId))).join())
    ) {
      // A plan change that joined the run since it was read keeps it alive.
      if (!(await writeDrop(ctx, run))) return 'moved';
      ctx.log.info('channels.apply.dropped', {
        runId,
        orgId: run.orgId,
        templateId: run.templateId,
      });
      return 'dropped';
    }
    // The requester must still hold templates:publish to replace codes; without it the run goes on
    // without the replacement.
    const lapsed =
      run.replace.length > 0 && !(await mayPublish(ctx.env.DB, run.orgId, run.requestedBy));
    if (
      await writeStart(
        ctx,
        run,
        to,
        stored?.revision ?? 0,
        lapsed ? REPLACE_PRINCIPAL_REVOKED : null,
      )
    )
      return 'started';
  } catch (error) {
    if (isOrgRefusal(error)) return 'inactive';
    throw error;
  }
  const ahead = await runningRun(ctx.env.DB, run.orgId, run.mode, run.templateId);
  if (!ahead) return 'moved';
  // The run ahead may be long (a big template); it counts as gone only when it stops making progress.
  return ctx.clock.now() - ahead.updatedAt > STALLED_AFTER_MS ? 'stalled' : 'blocked';
}

/** Whether the started run replaces codes (the requester kept the right): only then do pages wait for windows. */
export async function isRotating(ctx: ServiceContext, runId: string): Promise<boolean> {
  const run = await getRun(ctx.env.DB, runId);
  return run !== null && rotating(run);
}

/**
 * Before a page of a run that replaces codes: while an event or scanning session that admits the
 * template is open, returns when to look again (at most one round away, after touching the run so it
 * does not read as stalled). Null when pages may go on.
 */
export async function gateOne(
  ctx: ServiceContext,
  runId: string,
): Promise<{ until: number | null }> {
  const run = await getRun(ctx.env.DB, runId);
  if (run?.state !== 'running' || !rotating(run)) return { until: null };
  const now = ctx.clock.now();
  const windows = await openWindows(ctx, run.orgId, run.mode, run.templateId, now, 1);
  if (!blockingWindow(windows)) return { until: null };
  await writeTouch(ctx, run);
  ctx.log.info('channels.apply.window_wait', { runId, orgId: run.orgId });
  return { until: Math.min(windowsCloseAt(windows, now + GATE_ROUND_MS), now + GATE_ROUND_MS) };
}

/** Ends a running run as done, audited once. Returns the state the run is in. */
export async function finishRun(ctx: ServiceContext, runId: string): Promise<string> {
  const run = await getRun(ctx.env.DB, runId);
  if (run?.state !== 'running') return run?.state ?? 'missing';
  await writeFinish(ctx, run, run.counts);
  ctx.log.info('channels.apply.done', { runId, orgId: run.orgId, ...run.counts });
  return 'done';
}

/** Ends a pending or running run as failed. A run that already ended stays as it is. */
export async function failRun(ctx: ServiceContext, runId: string, code: string): Promise<void> {
  const run = await getRun(ctx.env.DB, runId);
  if (!run || (run.state !== 'pending' && run.state !== 'running')) return;
  // Marks already written still owe their events to the journal.
  if (run.state === 'running') await journal(ctx, run, true);
  await writeFail(ctx, run, code);
  ctx.log.error('channels.apply.failed', { runId, orgId: run.orgId, code });
}

/**
 * A long run outgrows one workflow instance: the next one (`{runId}-cN`) resumes from the cursor. The
 * hand-off counts as progress for the status check. An instance that already exists is fine (a retry).
 */
export async function handOff(ctx: ServiceContext, runId: string, next: number): Promise<void> {
  const run = await getRun(ctx.env.DB, runId);
  if (run?.state !== 'running') return;
  await writeTouch(ctx, run);
  try {
    await ctx.env.CHANNEL_APPLY.create({ id: `${runId}-c${next}`, params: { runId, cont: next } });
  } catch (error) {
    if (!/already.?exist/i.test(error instanceof Error ? error.message : String(error)))
      throw error;
  }
  ctx.log.info('channels.apply.handoff', { runId, orgId: run.orgId, instance: next });
}

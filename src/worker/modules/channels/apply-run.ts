import { templateDefault } from '../../../shared/channels.ts';
import { CHANNELS } from '../../../shared/contracts/channels.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { journal } from './apply-journal.ts';
import { getPolicy, type Policy } from './repo.ts';
import { writeDrop, writeFail, writeFinish, writeStart } from './repo-apply-write.ts';
import { getRun, runningRun } from './repo-runs.ts';

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
export const isOrgRefusal = (error: unknown): boolean =>
  error instanceof AppError && error.code === 'ORG_ACCESS_CHANGED';

const same = (a: Policy, b: Policy): boolean =>
  CHANNELS.every((c) => (a[c] ?? templateDefault(c)) === (b[c] ?? templateDefault(c)));

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
  try {
    if (same(run.from, to)) {
      await writeDrop(ctx, run);
      ctx.log.info('channels.apply.dropped', {
        runId,
        orgId: run.orgId,
        templateId: run.templateId,
      });
      return 'dropped';
    }
    if (await writeStart(ctx, run, to, stored?.revision ?? 0)) return 'started';
  } catch (error) {
    if (isOrgRefusal(error)) return 'inactive';
    throw error;
  }
  const ahead = await runningRun(ctx.env.DB, run.orgId, run.mode, run.templateId);
  if (!ahead) return 'moved';
  // The run ahead may be long (a big template); it counts as gone only when it stops making progress.
  return ctx.clock.now() - ahead.updatedAt > STALLED_AFTER_MS ? 'stalled' : 'blocked';
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
  if (run.state === 'running') await journal(ctx, run);
  await writeFail(ctx, run, code);
  ctx.log.error('channels.apply.failed', { runId, orgId: run.orgId, code });
}

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { applyChannelPage } from '../modules/channels/apply-page.ts';
import {
  dueOf,
  failRun,
  finishRun,
  gateOne,
  isRotating,
  ORG_INACTIVE,
  PREDECESSOR_STALLED,
  startOne,
  WINDOW_TIMEOUT,
} from '../modules/channels/apply-run.ts';
import type { Clock } from '../platform/clock.ts';
import type { AppEnv } from '../platform/env.ts';
import { createJobContext } from '../platform/service-context.ts';

export interface ChannelApplyParams {
  runId: string;
}

/** Saves that may push the start back. A run behind another waits as long as the run ahead makes progress. */
const MAX_DEBOUNCE = 50;
const MAX_PAGES = 2000;
/** Gate rounds of five minutes: a window open longer than two days fails the run. */
const MAX_GATE_ROUNDS = 576;
const PAGE_RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } } as const;

type StepLike = Pick<WorkflowStep, 'do' | 'sleep' | 'sleepUntil'>;

/** Waits out the debounce, starts the run, applies it page by page, and ends it. Owner: channels module. */
export async function runChannelApply(
  env: AppEnv,
  instanceId: string,
  params: ChannelApplyParams,
  step: StepLike,
  exec?: ExecutionContext,
  clock?: Clock,
): Promise<{ state: string }> {
  const { runId } = params;
  const ctx = createJobContext(env, 'channel-apply', {
    ...(clock ? { clock } : {}),
    ...(exec ? { ctx: exec } : {}),
    base: { workflow: 'channel-apply', instanceId, runId },
  });
  try {
    let debounce = 0;
    let blocked = 0;
    for (;;) {
      const n = debounce + blocked;
      const due = await step.do(`due-${n}`, () => dueOf(ctx, runId));
      if (due.state !== 'pending') return { state: due.state };
      if (due.dueAt > due.now && debounce < MAX_DEBOUNCE) {
        debounce++;
        await step.sleepUntil(`wait-${n}`, new Date(due.dueAt));
        continue;
      }
      const started = await step.do(`start-${n}`, () => startOne(ctx, runId));
      if (started === 'dropped' || started === 'skipped') return { state: started };
      if (started === 'inactive') {
        await step.do('fail', () => failRun(ctx, runId, ORG_INACTIVE));
        return { state: 'failed' };
      }
      if (started === 'stalled') {
        await step.do('fail', () => failRun(ctx, runId, PREDECESSOR_STALLED));
        return { state: 'failed' };
      }
      if (started === 'started') break;
      blocked++;
      if (started === 'blocked') await step.sleep(`blocked-${n}`, '5 minutes');
    }
    let gates = 0;
    const replacing = await step.do('rotating', () => isRotating(ctx, runId));
    for (let n = 0; ; n++) {
      if (n >= MAX_PAGES) throw new Error('channel apply ran out of pages');
      // A window that opens mid-run pauses the pages until it closes.
      while (replacing) {
        const gate = await step.do(`gate-${n}-${gates}`, () => gateOne(ctx, runId));
        if (gate.until === null) break;
        if (++gates > MAX_GATE_ROUNDS) {
          await step.do('fail', () => failRun(ctx, runId, WINDOW_TIMEOUT));
          return { state: 'failed' };
        }
        await step.sleepUntil(`window-${n}-${gates}`, new Date(gate.until));
      }
      const page = await step.do(`page-${n}`, PAGE_RETRY, () => applyChannelPage(ctx, runId));
      if (page.failed) {
        const code = page.failed;
        await step.do('fail', () => failRun(ctx, runId, code));
        return { state: 'failed' };
      }
      if (page.done) break;
      await step.sleep(
        `rest-${n}`,
        `${Math.max(1, Math.ceil((page.wait ?? 60_000) / 1000))} seconds`,
      );
    }
  } catch (error) {
    await step.do('fail', () => failRun(ctx, runId, 'CHANNEL_APPLY_FAILED'));
    throw error;
  }
  return { state: await step.do('finish', () => finishRun(ctx, runId)) };
}

export class ChannelApply extends WorkflowEntrypoint<AppEnv, ChannelApplyParams> {
  override async run(event: WorkflowEvent<ChannelApplyParams>, step: WorkflowStep): Promise<void> {
    await runChannelApply(this.env, event.instanceId, event.payload, step, this.ctx);
  }
}

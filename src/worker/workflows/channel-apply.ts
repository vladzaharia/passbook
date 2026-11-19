import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { applyChannelPage } from '../modules/channels/apply-page.ts';
import {
  dueOf,
  failRun,
  finishRun,
  ORG_INACTIVE,
  PREDECESSOR_STALLED,
  startOne,
} from '../modules/channels/apply-run.ts';
import type { Clock } from '../platform/clock.ts';
import type { AppEnv } from '../platform/env.ts';
import { createJobContext } from '../platform/service-context.ts';

export interface ChannelApplyParams {
  runId: string;
}

/** Saves that may push the start back, and rounds (5 minutes each) spent waiting for an earlier run of the template that still makes progress. */
const MAX_DEBOUNCE = 50;
const MAX_BLOCKED = 300;
const MAX_PAGES = 2000;
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
      if (++blocked > MAX_BLOCKED) throw new Error('channel apply never started');
      if (started === 'blocked') await step.sleep(`blocked-${n}`, '5 minutes');
    }
    for (let n = 0; ; n++) {
      if (n >= MAX_PAGES) throw new Error('channel apply ran out of pages');
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

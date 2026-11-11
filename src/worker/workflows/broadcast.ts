import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { applyChunk } from '../modules/broadcasts/apply.ts';
import { finishBroadcast, sendStepAllowed, startedBroadcast } from '../modules/broadcasts/run.ts';
import type { BroadcastParams } from '../modules/broadcasts/start.ts';
import type { AppEnv } from '../platform/env.ts';
import { createJobContext } from '../platform/service-context.ts';

const MAX_CHUNKS = 10_000;
const CHUNK_RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } } as const;

type StepLike = Pick<WorkflowStep, 'do'>;

/** Applies a broadcast in chunks of `CHUNK` passes. Owner: broadcasts module. */
export async function runBroadcast(
  env: AppEnv,
  instanceId: string,
  params: BroadcastParams,
  step: StepLike,
  exec?: ExecutionContext,
): Promise<{ state: string }> {
  const ctx = createJobContext(env, 'broadcast', {
    ...(exec ? { ctx: exec } : {}),
    base: { workflow: 'broadcast', instanceId, broadcastId: params.broadcastId },
  });
  try {
    const started = await step.do('start', () =>
      startedBroadcast(ctx, instanceId, params.broadcastId),
    );
    if (!started) return { state: 'skipped' };
    let cursor: string | null = null;
    for (let n = 0; n < MAX_CHUNKS; n++) {
      const from: string | null = cursor;
      if (!(await step.do(`gate-${n}`, () => sendStepAllowed(ctx, params.broadcastId)))) break;
      const result: { nextCursor: string | null } = await step.do(`chunk-${n}`, CHUNK_RETRY, () =>
        applyChunk(ctx, params.broadcastId, from),
      );
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
  } catch (error) {
    await step.do('fail', () =>
      finishBroadcast(ctx, instanceId, params.broadcastId, 'BROADCAST_FAILED'),
    );
    throw error;
  }
  const state = await step.do('finish', () => finishBroadcast(ctx, instanceId, params.broadcastId));
  return { state };
}

export class Broadcast extends WorkflowEntrypoint<AppEnv, BroadcastParams> {
  override async run(event: WorkflowEvent<BroadcastParams>, step: WorkflowStep): Promise<void> {
    await runBroadcast(this.env, event.instanceId, event.payload, step, this.ctx);
  }
}

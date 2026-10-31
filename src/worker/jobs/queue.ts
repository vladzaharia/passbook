import { handleDeadLetter } from '../modules/delivery/jobs.ts';
import type { AppEnv } from '../platform/env.ts';
import { AppError } from '../platform/errors.ts';
import { createServiceContext } from '../platform/service-context.ts';
import { estimateQueries, QUEUE_QUERY_BUDGET } from './query-budget.ts';
import { JOB_HANDLERS } from './registry.ts';
import { type Job, JobSchema } from './types.ts';

export const JOBS_QUEUE = 'wallet-jobs';
export const DLQ_QUEUE = 'wallet-jobs-dlq';

/** Exponential backoff in seconds for the nth attempt (30 s, 1 min, 2 min, ... capped at 1 h). */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}

async function dispatch(job: Job, env: AppEnv, ctx: ExecutionContext): Promise<void> {
  const handler = JOB_HANDLERS[job.kind] as (
    job: Job,
    ctx: ReturnType<typeof createServiceContext>,
  ) => Promise<void>;
  await handler(job, createServiceContext(env, { ctx, base: { job: job.kind } }));
}

/** Deferred messages come back after this many seconds, in a fresh invocation with a fresh budget. */
const DEFER_SECONDS = 5;

/**
 * Queue consumer. Handlers throw on transient errors (retried with backoff); invalid messages
 * are acknowledged and logged. The DLQ consumer finalizes exhausted jobs.
 */
export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: AppEnv,
  ctx: ExecutionContext,
  queryBudget = QUEUE_QUERY_BUDGET,
): Promise<void> {
  const base = createServiceContext(env, { ctx });
  if (batch.queue === DLQ_QUEUE) {
    for (const message of batch.messages) {
      const parsed = JobSchema.safeParse(message.body);
      try {
        if (parsed.success) await handleDeadLetter(parsed.data, base);
        message.ack();
      } catch (error) {
        base.log.error('queue.dlq_failed', { error });
        message.retry({ delaySeconds: 300 });
      }
    }
    return;
  }
  // One invocation shares D1's per-invocation query limit across the whole batch. Once the
  // estimated spend reaches the budget the remainder is retried in a new invocation; the first
  // message always runs.
  let used = 0;
  let ran = 0;
  for (const message of batch.messages) {
    const parsed = JobSchema.safeParse(message.body);
    if (!parsed.success) {
      base.log.error('queue.invalid_message', { id: message.id });
      message.ack();
      continue;
    }
    const cost = estimateQueries(parsed.data);
    if (ran > 0 && used + cost > queryBudget) {
      base.log.info('queue.budget_deferred', { job: parsed.data.kind, used, cost });
      message.retry({ delaySeconds: DEFER_SECONDS });
      continue;
    }
    ran++;
    used += cost;
    try {
      await dispatch(parsed.data, env, ctx);
      message.ack();
    } catch (error) {
      base.log.warn('queue.job_failed', {
        job: parsed.data.kind,
        attempts: message.attempts,
        code: error instanceof AppError ? error.code : 'ERROR',
        error,
      });
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

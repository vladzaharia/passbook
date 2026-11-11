import {
  retainDeadLetterWebhook,
  retainLegacyQueuedWebhook,
} from '../modules/connections/webhook-retention.ts';
import { handleDeadLetter } from '../modules/delivery/jobs.ts';
import type { AppEnv } from '../platform/env.ts';
import { AppError } from '../platform/errors.ts';
import { createJobContext, type ServiceContext } from '../platform/service-context.ts';
import { estimateQueries, QUEUE_QUERY_BUDGET } from './query-budget.ts';
import { runJob } from './registry.ts';
import { DLQ_QUEUE, retryDelaySeconds } from './retry.ts';
import { type Job, JobSchema, LegacyJobSchema } from './types.ts';

function dispatch(job: Job, env: AppEnv, ctx: ExecutionContext): Promise<void> {
  return runJob(job, createJobContext(env, job.kind, { ctx }));
}

/** Deferred messages come back after this many seconds, in a fresh invocation with a fresh budget. */
const DEFER_SECONDS = 5;

/** The DLQ consumer gives up on a message after this many attempts. */
const DLQ_MAX_ATTEMPTS = 3;

/** DLQ failures that retrying cannot fix. */
const DETERMINISTIC_DLQ_CODES = new Set(['WEBHOOK_PAYLOAD_MISSING', 'WEBHOOK_CONTEXT_CONFLICT']);

const STABLE_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const safeCode = (error: unknown, fallback: string) =>
  error instanceof AppError && STABLE_CODE.test(error.code) ? error.code : fallback;
const codeOf = (error: unknown) => (error instanceof AppError ? error.code : 'DLQ_FAILED');

/**
 * Baseline-shaped messages carry no tenant binding and are never run. Log them; a webhook is
 * retained as ignored under its stored connection. Returns false for any other shape.
 */
async function retainLegacyJob(base: ServiceContext, message: Message<unknown>): Promise<boolean> {
  const legacy = LegacyJobSchema.safeParse(message.body);
  if (!legacy.success) return false;
  base.log.warn('queue.legacy_job_ignored', {
    id: message.id,
    job: legacy.data.kind,
    code: 'LEGACY_JOB_IGNORED',
  });
  if (legacy.data.kind === 'connection.webhook') await retainLegacyQueuedWebhook(base, legacy.data);
  return true;
}

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
  const base = createJobContext(env, 'queue', { ctx });
  if (batch.queue === DLQ_QUEUE) {
    for (const message of batch.messages) {
      const parsed = JobSchema.safeParse(message.body);
      try {
        if (parsed.success) {
          if (parsed.data.kind === 'connection.webhook')
            await retainDeadLetterWebhook(base, parsed.data);
          else await handleDeadLetter(parsed.data, base);
        } else if (!(await retainLegacyJob(base, message))) {
          base.log.error('queue.invalid_message', { id: message.id, code: 'INVALID_MESSAGE' });
        }
        message.ack();
      } catch (error) {
        const webhook = parsed.success && parsed.data.kind === 'connection.webhook';
        // Webhook errors can carry upstream-controlled text: log only their stable code.
        const code = webhook ? safeCode(error, 'WEBHOOK_RETENTION_FAILED') : codeOf(error);
        const kind = parsed.success ? parsed.data.kind : 'invalid';
        const final = message.attempts >= DLQ_MAX_ATTEMPTS;
        // A deterministic code cannot succeed on a later attempt.
        if (final || (webhook && DETERMINISTIC_DLQ_CODES.has(code))) {
          base.log.error('queue.dlq_dropped', {
            kind,
            id: message.id,
            code,
            ...(webhook ? {} : { error }),
          });
          message.ack();
        } else {
          // A webhook's encrypted source is staged before enqueue. Never ACK a failed DLQ write early.
          base.log.error('queue.dlq_failed', {
            id: message.id,
            code,
            ...(webhook ? {} : { error }),
          });
          message.retry({ delaySeconds: 300 });
        }
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
      try {
        if (!(await retainLegacyJob(base, message))) {
          base.log.error('queue.invalid_message', { id: message.id, code: 'INVALID_MESSAGE' });
        }
        message.ack();
      } catch (error) {
        base.log.warn('queue.legacy_job_failed', {
          id: message.id,
          attempts: message.attempts,
          code: safeCode(error, 'LEGACY_JOB_FAILED'),
        });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
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
      if (parsed.data.kind === 'connection.webhook') {
        base.log.warn('queue.job_failed', {
          job: parsed.data.kind,
          attempts: message.attempts,
          code:
            error instanceof AppError && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)
              ? error.code
              : 'WEBHOOK_FAILED',
        });
      } else {
        base.log.warn('queue.job_failed', {
          job: parsed.data.kind,
          attempts: message.attempts,
          code: error instanceof AppError ? error.code : 'ERROR',
          error,
        });
      }
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

import type { Context } from 'hono';
import { type Clock, systemClock } from './clock.ts';
import type { AppBindings } from './context.ts';
import type { AppEnv } from './env.ts';
import { createIds, type Ids } from './ids.ts';
import { hasFullJobAuthority, type JobAuthority, withJobAuthority } from './job-authority.ts';
import { createLogger, type Logger } from './log.ts';

/**
 * What services receive. Built from a request (`serviceContext(c)`), from a queue, cron or workflow
 * entry point (`createJobContext`), or detached from either (`createDetachedContext`). Services never
 * touch Hono.
 */
export interface ServiceContext {
  env: AppEnv;
  clock: Clock;
  ids: Ids;
  log: Logger;
  requestId: string | null;
  /** Set by `createJobContext` only; `jobGrant` refuses a context without it. */
  job?: JobAuthority;
  /** The job kind a job context was made for, so a grant's audit row names it. */
  jobName?: string;
  /** Daily cron only: D1 queries the shared daily budget has spent so far, across every hook. */
  spent?: () => number;
  /** The request's key came as a developer try token: its audit rows carry `via: 'try'`. */
  via?: 'try';
  /** A cron invocation's D1 queries so far (D1 allows 1,000); only the daily cron sets it. */
  queries?: () => number;
  waitUntil(promise: Promise<unknown>): void;
}

/** A rejected background promise is logged, never dropped. */
function reportFailure(promise: Promise<unknown>, log: Logger): Promise<unknown> {
  return promise.catch((error) => log.warn('waituntil.failed', { code: 'WAIT_UNTIL', error }));
}

export function serviceContext(c: Context<AppBindings>): ServiceContext {
  return {
    env: c.env,
    clock: c.var.clock,
    ids: c.var.ids,
    log: c.var.log,
    requestId: c.var.requestId,
    ...(c.var.auth?.kind === 'api_key' && c.var.auth.via ? { via: c.var.auth.via } : {}),
    waitUntil: (promise) => {
      const reported = reportFailure(promise, c.var.log);
      try {
        c.executionCtx.waitUntil(reported);
      } catch {
        // No execution context (tests, scripts): the promise already runs detached.
      }
    },
  };
}

interface ContextOptions {
  clock?: Clock;
  log?: Logger;
  ctx?: ExecutionContext;
  base?: Record<string, unknown>;
  queries?: () => number;
}

/** No request and no job brand: a Durable Object, a store or a cache. It cannot mint a `system:` grant. */
export function createDetachedContext(env: AppEnv, options: ContextOptions = {}): ServiceContext {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? createLogger({ build: env.CF_VERSION?.id, ...options.base });
  return {
    env,
    clock,
    ids: createIds(clock),
    log,
    requestId: null,
    ...(options.queries ? { queries: options.queries } : {}),
    waitUntil: (promise) => {
      const reported = reportFailure(promise, log);
      options.ctx?.waitUntil(reported);
    },
  };
}

/** True for a context built by `createJobContext`; the brand cannot be forged outside this module. */
export const isJobContext = (ctx: { job?: JobAuthority | undefined }): boolean =>
  hasFullJobAuthority(ctx);

/** Queue, cron and workflow entry points only (`tools/authority-scope.ts` lints other callers). */
export function createJobContext(
  env: AppEnv,
  kind: string,
  options: ContextOptions & { allowedPurposes?: readonly string[] } = {},
): ServiceContext {
  const { allowedPurposes, ...rest } = options;
  return {
    ...withJobAuthority(
      createDetachedContext(env, { ...rest, base: { job: kind, ...rest.base } }),
      allowedPurposes,
    ),
    jobName: kind,
  };
}

/** The detached form, kept for tests and fixtures that need a plain context. */
export const createServiceContext = createDetachedContext;

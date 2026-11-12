import type { Context } from 'hono';
import { type Clock, systemClock } from './clock.ts';
import type { AppBindings } from './context.ts';
import type { AppEnv } from './env.ts';
import { createIds, type Ids } from './ids.ts';
import { type JobAuthority, withJobAuthority } from './job-authority.ts';
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
    waitUntil: (promise) => {
      const reported = reportFailure(promise, log);
      options.ctx?.waitUntil(reported);
    },
  };
}

/** Queue, cron and workflow entry points only (`tools/authority-scope.ts` lints other callers). */
export function createJobContext(
  env: AppEnv,
  kind: string,
  options: ContextOptions = {},
): ServiceContext {
  return withJobAuthority(
    createDetachedContext(env, { ...options, base: { job: kind, ...options.base } }),
  );
}

/** The detached form, kept for tests and fixtures that need a plain context. */
export const createServiceContext = createDetachedContext;

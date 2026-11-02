import type { Context } from 'hono';
import { type Clock, systemClock } from './clock.ts';
import type { AppBindings } from './context.ts';
import type { AppEnv } from './env.ts';
import { createIds, type Ids } from './ids.ts';
import { createLogger, type Logger } from './log.ts';

/**
 * What services receive. Built from a request (`serviceContext(c)`) or from a non-HTTP entry point
 * (queue, cron, workflow) with `createServiceContext(env)`. Services never touch Hono.
 */
export interface ServiceContext {
  env: AppEnv;
  clock: Clock;
  ids: Ids;
  log: Logger;
  requestId: string | null;
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

export function createServiceContext(
  env: AppEnv,
  options: {
    clock?: Clock;
    log?: Logger;
    ctx?: ExecutionContext;
    base?: Record<string, unknown>;
  } = {},
): ServiceContext {
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

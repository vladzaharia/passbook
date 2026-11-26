import { Context } from 'hono';
import { afterEach } from 'vitest';

/**
 * A request sent without an execution context runs its `waitUntil` work detached (see `serviceContext`).
 * That work reaches Durable Objects and queues, which load the Worker entry lazily; when it outlives the
 * test file Vitest has already torn the environment down and logs an EnvironmentTeardownError.
 * Hand such requests a collecting context and await what they deferred before the test ends.
 */
const deferred: Promise<unknown>[] = [];
const contexts = new WeakMap<object, ExecutionContext>();
const real = Object.getOwnPropertyDescriptor(Context.prototype, 'executionCtx');

Object.defineProperty(Context.prototype, 'executionCtx', {
  configurable: true,
  get(this: Context) {
    try {
      return real?.get?.call(this);
    } catch {
      let ctx = contexts.get(this);
      if (!ctx) {
        ctx = {
          waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
          passThroughOnException: () => {},
          props: {},
        } as unknown as ExecutionContext;
        contexts.set(this, ctx);
      }
      return ctx;
    }
  },
});

afterEach(async () => {
  while (deferred.length > 0) await Promise.allSettled(deferred.splice(0));
});

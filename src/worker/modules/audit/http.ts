import type { Context } from 'hono';
import type { Actor } from '../../platform/context.ts';
import { type AppBindings, actorOf } from '../../platform/context.ts';

type Target = 'query' | 'param' | 'json';

/** Validated request input (the route's zod schema already ran). */
export function valid<T>(c: Context<AppBindings>, target: Target): T {
  return (c.req as unknown as { valid(target: Target): unknown }).valid(target) as T;
}

export function requestActor(c: Context<AppBindings>): Actor {
  return actorOf(c.var.auth);
}

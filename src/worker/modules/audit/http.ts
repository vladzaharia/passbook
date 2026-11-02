import type { Context } from 'hono';
import type { Actor } from '../../platform/context.ts';
import { type AppBindings, actorOf } from '../../platform/context.ts';

/** Validated request input (the route's zod schema already ran). */
export function requestActor(c: Context<AppBindings>): Actor {
  return actorOf(c.var.auth);
}

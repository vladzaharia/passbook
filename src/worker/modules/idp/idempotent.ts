import type { Context } from 'hono';
import type { AppBindings } from '../../platform/context.ts';
import { idempotentJson, principalOf } from '../../platform/idempotency.ts';
import { serviceContext } from '../../platform/service-context.ts';

/**
 * `Idempotency-Key` for a platform write: the same key and request answers again from the first call. A platform
 * write belongs to no org, so the scope is the platform's own; two principals never share a key.
 */
export function idpIdempotent<T>(
  c: Context<AppBindings>,
  body: unknown,
  status: 200 | 201,
  execute: (ctx: ReturnType<typeof serviceContext>) => Promise<T>,
): Promise<Response> {
  const auth = c.var.auth;
  if (!auth) throw new Error('A principal is required.');
  const ctx = serviceContext(c);
  return idempotentJson(
    c,
    ctx,
    { orgId: 'platform', mode: 'live', principal: principalOf(auth), body },
    status,
    () => execute(ctx),
  );
}

import type { Context } from 'hono';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { idempotencyKeyHeader, principalOf, withIdempotency } from '../../platform/idempotency.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/**
 * `Idempotency-Key` for a call that returns a secret: the first call runs once and gets the secret; the stored
 * response (24 hours, plain in D1) is kept without it, so a replay returns the key and never the secret. A client
 * that lost the response rotates or revokes again.
 */
export async function idempotentSecret<T>(
  c: Context<AppBindings>,
  ctx: ServiceContext,
  orgId: string | null,
  body: unknown,
  status: 201,
  execute: () => Promise<T>,
  /** The stored form of the response: the same, minus every secret. */
  redact: (full: T) => unknown,
): Promise<Response> {
  const key = idempotencyKeyHeader(c.req.header('idempotency-key'));
  if (key === undefined) return c.json((await execute()) as never, status);
  const auth = c.var.auth;
  if (!auth) throw new Error('A principal is required.');
  let full: T | undefined;
  const result = await withIdempotency(
    ctx,
    {
      orgId: orgId ?? 'platform',
      mode: modeOf(auth),
      principal: principalOf(auth),
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      request: { method: c.req.method, path: c.req.path, body },
    },
    async () => {
      full = await execute();
      return { status, body: redact(full) };
    },
  );
  if (!result.replayed) return c.json(full as never, status);
  c.header('Idempotent-Replayed', 'true');
  return c.json(result.body as never, result.status as 201);
}

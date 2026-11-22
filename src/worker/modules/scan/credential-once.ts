import type { Context } from 'hono';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { idempotencyKeyHeader, principalOf, withIdempotency } from '../../platform/idempotency.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/**
 * The stored form of an answer, by allowlist: only the fields of its schema, with the secret fields null.
 * A field added to the answer later is stored only if the schema names it, and never a secret by accident.
 */
export function withoutSecrets(
  schema: { shape: Record<string, unknown> },
  value: object,
  secrets: readonly string[],
): Record<string, unknown> {
  const from = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(schema.shape).map((k) => [k, secrets.includes(k) ? null : from[k]]),
  );
}

export interface CredentialOnce<T> {
  orgId: string;
  /** What the request means, hashed to tell a retry from another request (the body and any query flag). */
  body: unknown;
  status: 200 | 201;
  execute: () => Promise<T>;
  /** The stored form of the answer: the same, minus every secret. */
  redact: (full: T) => unknown;
}

/**
 * `Idempotency-Key` for a call that makes a secret. Without the header the call just runs and nothing
 * is stored. With it, the first call runs once and gets the secret; the answer kept for a replay has
 * every secret null, so a replay returns the same ids with `Idempotent-Replayed: true` and never the
 * secret. A caller that lost the answer calls again without the key, which replaces the credential.
 */
export async function credentialOnce<T>(
  c: Context<AppBindings>,
  ctx: ServiceContext,
  { orgId, body, status, execute, redact }: CredentialOnce<T>,
): Promise<Response> {
  const key = idempotencyKeyHeader(c.req.header('idempotency-key'));
  if (key === undefined) return c.json((await execute()) as never, status);
  const auth = c.var.auth;
  if (!auth) throw new Error('A principal is required.');
  let full: T | undefined;
  const result = await withIdempotency(
    ctx,
    {
      orgId,
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
  return c.json(result.body as never, result.status as 200);
}

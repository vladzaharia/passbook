import type { Context } from 'hono';
import type { AuthContext } from './auth.ts';
import type { AppBindings } from './context.ts';
import { BadRequestError, ConflictError, ValidationError } from './errors.ts';
import { sha256Hex } from './ids.ts';
import {
  claimRequest,
  deleteExpiredRequests,
  dropUnsettled,
  type IdempotencyId,
  requestRow,
  settleRequest,
} from './repo-idempotency.ts';
import type { ServiceContext } from './service-context.ts';

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
/** A claim with no stored response this old belongs to a dead first call and is reclaimed. */
const IN_PROGRESS_MS = 15 * 60_000;

export interface IdempotencyScope {
  orgId: string;
  mode: string;
  /** `session:<userId>` or `key:<keyId>`: two principals never share a key. */
  principal: string;
  /** Names the route, e.g. `POST /passes`; the same key on another route never collides. */
  operation: string;
  key: string;
  /** Method, path, body and principal are hashed; pass the parsed body. */
  request: { method: string; path: string; body: unknown };
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

export function principalOf(auth: AuthContext): string {
  // A Workbench token's Test answers never replay as the person's own (Live and Test) ones, or back.
  if (auth.kind === 'session')
    return auth.workbench ? `wb:${auth.workbench.orgId}:${auth.userId}` : `session:${auth.userId}`;
  if (auth.kind === 'api_key') return `key:${auth.keyId}`;
  return `scanner:${auth.scannerId}`;
}

/**
 * Key prefixes the server writes itself into `idempotency_keys`: the scopes of `sendOnce`, and Tell
 * holders' shared reservation. POST /passes stores its client key unprefixed in the same table, so it
 * alone refuses them (`assertKeyNotReserved`); every other route namespaces the client key.
 */
export const RESERVED_KEY_PREFIXES = ['broadcast-create:', 'bulk-send:', 'rollout-tell:'] as const;

/** 422 `IDEMPOTENCY_KEY_RESERVED` for a client key that starts with an internal prefix (except `allowed`). */
export function assertKeyNotReserved(key: string): void {
  const prefix = RESERVED_KEY_PREFIXES.find((p) => key.startsWith(p));
  if (prefix)
    throw new ValidationError(
      `Idempotency-Key cannot start with "${prefix}": that prefix is reserved.`,
      [],
      'IDEMPOTENCY_KEY_RESERVED',
    );
}

/** The trimmed `Idempotency-Key` header, or undefined when absent. */
export function idempotencyKeyHeader(header: string | undefined): string | undefined {
  const raw = header?.trim();
  if (raw === undefined) return undefined;
  if (raw.length < 1 || raw.length > 200)
    throw new BadRequestError(
      'Idempotency-Key must be 1 to 200 characters.',
      'IDEMPOTENCY_KEY_INVALID',
    );
  return raw;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

/**
 * Runs `execute` once per (org, mode, principal, operation, key) and stores its response for 24 hours.
 * A replay returns that response (`replayed: true`); the same key with another request is 422
 * `IDEMPOTENCY_KEY_REUSED`; a replay while the first call runs is 409 `IDEMPOTENCY_IN_PROGRESS`.
 * A thrown error releases the key so a retry can run again.
 */
export async function withIdempotency(
  ctx: ServiceContext,
  scope: IdempotencyScope,
  execute: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const db = ctx.env.DB;
  const hash = await sha256Hex(
    canonical([scope.request.method, scope.request.path, scope.request.body, scope.principal]),
  );
  const id: IdempotencyId = [scope.orgId, scope.mode, scope.principal, scope.operation, scope.key];
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = ctx.clock.now();
    if (await claimRequest(db, id, hash, now, now + IDEMPOTENCY_TTL_MS)) {
      let result: StoredResponse;
      try {
        result = await execute();
      } catch (error) {
        await dropUnsettled(db, id, { hash });
        throw error;
      }
      await settleRequest(db, id, result.status, JSON.stringify(result.body ?? null));
      return { ...result, replayed: false };
    }
    const row = await requestRow(db, id);
    if (!row) continue;
    if (row.request_hash !== hash)
      throw new ValidationError(
        'This Idempotency-Key was used for a different request.',
        [],
        'IDEMPOTENCY_KEY_REUSED',
      );
    if (row.status !== null)
      return { status: row.status, body: JSON.parse(row.body ?? 'null'), replayed: true };
    if (now - row.created_at < IN_PROGRESS_MS)
      throw new ConflictError('The first request is still running.', 'IDEMPOTENCY_IN_PROGRESS');
    await dropUnsettled(db, id, { createdAt: row.created_at });
  }
  throw new ConflictError('The first request is still running.', 'IDEMPOTENCY_IN_PROGRESS');
}

/**
 * Route helper: without the header it just runs; with it, replays set `Idempotent-Replayed: true`.
 * `execute` returns the JSON body; `status` is the success status.
 */
export async function idempotentJson<T>(
  c: Context<AppBindings>,
  ctx: ServiceContext,
  scope: Omit<IdempotencyScope, 'request' | 'key' | 'operation'> & { body: unknown },
  status: 200 | 201 | 202,
  execute: () => Promise<T>,
  /** Recomputes the body on a replay when the stored one can go stale (a send outcome, a superseded release). */
  replay?: () => Promise<T>,
): Promise<Response> {
  const key = idempotencyKeyHeader(c.req.header('idempotency-key'));
  if (key === undefined) return c.json((await execute()) as never, status);
  const result = await withIdempotency(
    ctx,
    {
      ...scope,
      key,
      operation: `${c.req.method} ${c.req.routePath}`,
      request: { method: c.req.method, path: c.req.path, body: scope.body },
    },
    async () => ({ status, body: await execute() }),
  );
  if (!result.replayed) return c.json(result.body as never, result.status as 200);
  c.header('Idempotent-Replayed', 'true');
  return c.json((replay ? await replay() : result.body) as never, result.status as 200);
}

const SWEEP_BATCH = 1000;
const SWEEP_MAX_BATCHES = 50;

/** Daily cron hook: drops expired responses, in bounded batches. */
export async function sweepIdempotency(ctx: ServiceContext): Promise<void> {
  let deleted = 0;
  for (let i = 0; i < SWEEP_MAX_BATCHES; i++) {
    const n = await deleteExpiredRequests(ctx.env.DB, ctx.clock.now(), SWEEP_BATCH);
    deleted += n;
    if (n < SWEEP_BATCH) break;
  }
  ctx.log.info('idempotency.sweep', { deleted });
}

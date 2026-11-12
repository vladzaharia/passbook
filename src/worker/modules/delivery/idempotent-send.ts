import { BadRequestError, ConflictError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { claimIdempotencyKey, releaseIdempotencyKey } from '../passes/repo-ops.ts';
import { idempotencyRow, reclaimIdempotencyKey, settleIdempotencyKey } from './repo-idempotency.ts';

const DONE = 'done:';

/** The trimmed `Idempotency-Key` header, or undefined when absent. */
export function idempotencyKeyOf(header: string | undefined): string | undefined {
  const raw = header?.trim();
  if (raw === undefined) return undefined;
  if (raw.length < 1 || raw.length > 200)
    throw new BadRequestError(
      'Idempotency-Key must be 1 to 200 characters.',
      'IDEMPOTENCY_KEY_INVALID',
    );
  return raw;
}

const IN_PROGRESS_MS = 15 * 60_000;

/**
 * Runs a send once per `(org, principal, key)`. The first call reserves the key and stores the JSON
 * result on it; a replay with the same request returns that result without sending again, a replay
 * with another request is `IDEMPOTENCY_KEY_REUSED`, and a replay while the first call is still
 * running is `IDEMPOTENCY_IN_PROGRESS`. An unsettled key older than 15 minutes (a dead first call)
 * is reclaimed. A failure releases the key for a retry unless `progress()` says something was
 * already queued: then the key stays, so a retry cannot send twice.
 */
export async function sendOnce<T>(
  ctx: ServiceContext,
  input: {
    orgId: string;
    scope: string;
    key: string;
    request: unknown;
    authority: TenantPassWrite;
    progress?: () => boolean;
  },
  send: () => Promise<T>,
): Promise<{ replayed: boolean; value: T }> {
  const db = ctx.env.DB;
  const principal =
    input.authority.kind === 'session' ? input.authority.userId : input.authority.keyId;
  const key = `${input.scope}:${principal}:${input.key}`;
  const hash = await sha256Hex(JSON.stringify(input.request));
  const replay = async (): Promise<{ replayed: true; value: T } | null> => {
    const existing = await idempotencyRow(db, input.orgId, key);
    if (!existing)
      throw new ConflictError('The pass or authorization changed. Retry.', 'PASS_CONFLICT');
    if (existing.request_hash !== hash)
      throw new ConflictError(
        'This Idempotency-Key was used for a different request.',
        'IDEMPOTENCY_KEY_REUSED',
      );
    if (existing.resource_id?.startsWith(DONE))
      return { replayed: true, value: JSON.parse(existing.resource_id.slice(DONE.length)) as T };
    if (ctx.clock.now() - existing.created_at < IN_PROGRESS_MS)
      throw new ConflictError('The first request is still running.', 'IDEMPOTENCY_IN_PROGRESS');
    await reclaimIdempotencyKey(db, input.orgId, key, existing.created_at, DONE);
    return null;
  };
  const existing = await idempotencyRow(db, input.orgId, key);
  if (existing) {
    const done = await replay();
    if (done) return done;
  }
  const reservation = ctx.ids.id();
  if (
    !(await claimIdempotencyKey(
      db,
      input.orgId,
      key,
      hash,
      reservation,
      ctx.clock.now(),
      input.authority,
    ))
  ) {
    const done = await replay();
    if (done) return done;
    throw new ConflictError('The first request is still running.', 'IDEMPOTENCY_IN_PROGRESS');
  }
  let value: T;
  try {
    value = await send();
  } catch (error) {
    if (!input.progress?.()) await releaseIdempotencyKey(db, input.orgId, key, reservation, hash);
    throw error;
  }
  await settleIdempotencyKey(db, input.orgId, key, reservation, `${DONE}${JSON.stringify(value)}`);
  return { replayed: false, value };
}

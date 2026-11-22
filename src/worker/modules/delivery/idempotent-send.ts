import { ConflictError, ValidationError } from '../../platform/errors.ts';
import { idempotencyKeyHeader } from '../../platform/idempotency.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { claimIdempotencyKey, releaseIdempotencyKey } from '../passes/repo-ops.ts';
import { idempotencyRow, reclaimIdempotencyKey, settleIdempotencyKey } from './repo-idempotency.ts';

const DONE = 'done:';

/** The trimmed `Idempotency-Key` header, or undefined when absent. */
export function idempotencyKeyOf(
  header: string | undefined,
  allowed: readonly string[] = [],
): string | undefined {
  return idempotencyKeyHeader(header, allowed);
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
    /**
     * One reservation for the whole organization (a send that must happen once, like Tell holders). Only
     * the principal who claimed it replays; any other gets 409 `TELL_ALREADY_SENT` and no stored body.
     */
    shared?: boolean;
  },
  send: () => Promise<T>,
): Promise<{ replayed: boolean; value: T }> {
  const db = ctx.env.DB;
  const principal =
    input.authority.kind === 'session' ? input.authority.userId : input.authority.keyId;
  const key = input.shared
    ? `${input.scope}:${input.key}`
    : `${input.scope}:${principal}:${input.key}`;
  // A shared reservation also leaves this principal's own row, which is how the claimant is known.
  const ownKey = `${input.scope}:${principal}:${input.key}`;
  const hash = await sha256Hex(JSON.stringify(input.request));
  const replay = async (): Promise<{ replayed: true; value: T } | null> => {
    const existing = await idempotencyRow(db, input.orgId, key);
    if (!existing)
      throw new ConflictError('The pass or authorization changed. Retry.', 'PASS_CONFLICT');
    if (existing.request_hash !== hash)
      throw new ValidationError(
        'This Idempotency-Key was used for a different request.',
        [],
        'IDEMPOTENCY_KEY_REUSED',
      );
    if (existing.resource_id?.startsWith(DONE)) {
      // The claimant's own row counts only as a finished Tell claim of this same request.
      const own = input.shared ? await idempotencyRow(db, input.orgId, ownKey) : null;
      if (input.shared && !(own?.request_hash === hash && own.resource_id === `${DONE}{}`))
        throw new ConflictError('Holders were already told for this release.', 'TELL_ALREADY_SENT');
      return { replayed: true, value: JSON.parse(existing.resource_id.slice(DONE.length)) as T };
    }
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
  const own = input.shared ? ctx.ids.id() : null;
  if (own)
    await claimIdempotencyKey(db, input.orgId, ownKey, hash, own, ctx.clock.now(), input.authority);
  let value: T;
  try {
    value = await send();
  } catch (error) {
    if (!input.progress?.()) {
      await releaseIdempotencyKey(db, input.orgId, key, reservation, hash);
      if (own) await releaseIdempotencyKey(db, input.orgId, ownKey, own, hash);
    }
    throw error;
  }
  if (own) await settleIdempotencyKey(db, input.orgId, ownKey, own, `${DONE}{}`);
  await settleIdempotencyKey(db, input.orgId, key, reservation, `${DONE}${JSON.stringify(value)}`);
  return { replayed: false, value };
}

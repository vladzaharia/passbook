import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { progressOf } from '../operations/progress.ts';
import type { Progress } from '../operations/progress-types.ts';
import { activeByDedupe } from '../operations/repo.ts';
import { dedupeKeyOf, startOperation } from '../operations/start.ts';

export type HolderKind = 'holder.refresh' | 'holder.remove' | 'holder.lost_phone' | 'holder.resend';

/** The signed-in holder an action acts for: the operation is read only by this session. */
export interface HolderSession {
  userId: string;
  sessionId: string;
}

const actorOf = (who: HolderSession) => ({ type: 'user', id: who.userId }) as const;

/**
 * Whether this holder has an operation of `kind` running on the pass, and its id if this session can read it: a
 * session reads only what it started, so another device's operation is not named.
 */
export async function activeHolderOperation(
  ctx: ServiceContext,
  who: HolderSession,
  kind: HolderKind,
  passId: string,
): Promise<{ id: string | null; running: boolean }> {
  const row = await activeRow(ctx, who, kind, passId);
  return { id: row && row.actor_session === who.sessionId ? row.id : null, running: row !== null };
}

async function activeRow(
  ctx: ServiceContext,
  who: HolderSession,
  kind: HolderKind,
  passId: string,
) {
  const key = dedupeKeyOf({ kind, actor: actorOf(who), subject: { passId } });
  return key ? activeByDedupe(ctx.env.DB, key) : null;
}

/**
 * Refuses a second action of one kind on one pass while the first runs, before the action itself, so a refused
 * start has changed nothing. The session that started it is told which (409 with its id); another device only that
 * it runs, with no id it could not read.
 */
export async function assertNoActiveHolderOperation(
  ctx: ServiceContext,
  who: HolderSession,
  kind: HolderKind,
  passId: string,
): Promise<void> {
  const row = await activeRow(ctx, who, kind, passId);
  if (!row) return;
  if (row.actor_session === who.sessionId)
    throw new AppError('OPERATION_RUNNING', 409, 'This is already running.', {
      operationId: row.id,
    });
  throw new AppError('OPERATION_RUNNING', 409, 'Already running on another device.');
}

/** Starts the operation for an action that has just been accepted. The target is the pass, never the holder. */
export async function startHolderOperation(
  ctx: ServiceContext,
  who: HolderSession,
  kind: HolderKind,
  passId: string,
): Promise<{ id: string; progress: Progress }> {
  const op = await startOperation(ctx, {
    kind,
    target: { type: 'pass', id: passId },
    actor: actorOf(who),
    session: who.sessionId,
    subject: { passId },
  });
  return { id: op.id, progress: progressOf(ctx, op.id, op.attempt) };
}

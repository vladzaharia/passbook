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

/** The id of this holder's active operation of `kind` on the pass, if one runs. */
export async function activeHolderOperation(
  ctx: ServiceContext,
  who: HolderSession,
  kind: HolderKind,
  passId: string,
): Promise<string | null> {
  const key = dedupeKeyOf({ kind, actor: actorOf(who), subject: { passId } });
  return key ? ((await activeByDedupe(ctx.env.DB, key))?.id ?? null) : null;
}

/**
 * Refuses a second action of one kind on one pass while the first runs (409 OPERATION_RUNNING with its id). Run
 * before the action itself, so a refused start has changed nothing.
 */
export async function assertNoActiveHolderOperation(
  ctx: ServiceContext,
  who: HolderSession,
  kind: HolderKind,
  passId: string,
): Promise<void> {
  const id = await activeHolderOperation(ctx, who, kind, passId);
  if (id)
    throw new AppError('OPERATION_RUNNING', 409, 'This is already running.', { operationId: id });
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

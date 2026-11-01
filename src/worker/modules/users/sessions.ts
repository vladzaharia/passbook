import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { revokeAllForUser, revokeOne } from '../auth/sessions.ts';
import * as repo from './repo.ts';
import { requireUser } from './service.ts';

export async function revokeUserSessions(
  ctx: ServiceContext,
  actorId: string,
  id: string,
): Promise<number> {
  await requireUser(ctx, id);
  const count = await revokeAllForUser(ctx, id);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId,
    action: 'user.sessions_revoke',
    targetType: 'user',
    targetId: id,
    detail: { count },
  });
  return count;
}

/** Revokes one session of the user; another user's session id is not found. */
export async function revokeUserSession(
  ctx: ServiceContext,
  actorId: string,
  id: string,
  sessionId: string,
): Promise<void> {
  await requireUser(ctx, id);
  const row = await repo.getSession(ctx.env.DB, sessionId);
  if (!row || row.user_id !== id)
    throw new NotFoundError('Session not found.', 'SESSION_NOT_FOUND');
  await revokeOne(ctx, sessionId);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId,
    action: 'session.revoke',
    targetType: 'user',
    targetId: id,
  });
}

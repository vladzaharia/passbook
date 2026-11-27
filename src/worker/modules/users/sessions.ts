import { callerActor, type PlatformCaller } from '../../platform/actor.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { revokeAllForUser, revokeOne } from '../auth/sessions.ts';
import * as repo from './repo.ts';
import { refuseAdminTargetForKey, requireUser } from './service.ts';

export async function revokeUserSessions(
  ctx: ServiceContext,
  who: PlatformCaller,
  id: string,
): Promise<number> {
  await refuseAdminTargetForKey(ctx, who, await requireUser(ctx, id));
  const count = await revokeAllForUser(ctx, id);
  const actor = callerActor(who);
  await recordAudit(ctx, {
    actorType: actor.type,
    actorId: actor.id,
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
  who: PlatformCaller,
  id: string,
  sessionId: string,
): Promise<void> {
  await refuseAdminTargetForKey(ctx, who, await requireUser(ctx, id));
  const row = await repo.getSession(ctx.env.DB, sessionId);
  if (!row || row.user_id !== id)
    throw new NotFoundError('Session not found.', 'SESSION_NOT_FOUND');
  await revokeOne(ctx, sessionId);
  const actor = callerActor(who);
  await recordAudit(ctx, {
    actorType: actor.type,
    actorId: actor.id,
    action: 'session.revoke',
    targetType: 'user',
    targetId: id,
  });
}

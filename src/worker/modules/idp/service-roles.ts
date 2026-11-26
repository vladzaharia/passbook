import type { Context } from 'hono';
import type { AccessView, GrantRole } from '../../../shared/contracts/idp-access.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ConflictError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { requireUser } from '../users/service.ts';
import { idpClient } from './client.ts';
import { accessView } from './dto.ts';
import { removedTarget } from './effects.ts';
import { needBinding } from './ops-start.ts';
import { isLiveAdmin } from './platform-admin.ts';
import { insertGrant, liveGrantOf, revokeGrant } from './repo-role-grants.ts';
import { statesOfUser } from './repo-state.ts';
import type { WritableRole } from './types.ts';

/** Who asked: a platform admin's session, or a platform key. Both land in the audit log. */
export type Actor = { type: 'user' | 'api_key'; id: string };

/** The audit actor of a call: the signed-in admin, or the platform key. */
export function actorOf(c: Context<AppBindings>): Actor {
  const auth = c.var.auth;
  if (auth?.kind === 'session') return { type: 'user', id: auth.userId };
  if (auth?.kind === 'api_key') return { type: 'api_key', id: auth.keyId };
  throw new UnauthenticatedError();
}

const ADMIN_MESSAGE = 'Platform admins hold every role. Change it in Polaris ID.';

async function nonAdmin(ctx: ServiceContext, userId: string) {
  const user = await requireUser(ctx, userId);
  if (await isLiveAdmin(ctx, userId, user.last_roles))
    throw new ConflictError(ADMIN_MESSAGE, 'IDP_PLATFORM_ADMIN');
  return user;
}

/**
 * Grants or revokes a platform role (developer, support). The change marks the user for the drain, which adds or
 * removes the group; repeating it changes nothing.
 */
export async function setPlatformRole(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
  body: GrantRole,
): Promise<AccessView> {
  needBinding(ctx);
  await nonAdmin(ctx, userId);
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const live = await liveGrantOf(db, userId, body.role);
  let changed = false;
  if (body.grant && !live) {
    await insertGrant(db, { id: ctx.ids.id(), userId, role: body.role, grantedBy: actor.id, now });
    changed = true;
  } else if (!body.grant && live) {
    changed = await revokeGrant(db, { userId, role: body.role, by: actor.id, now });
  }
  if (changed)
    await recordAudit(ctx, {
      actorType: actor.type,
      actorId: actor.id,
      action: body.grant ? 'idp.role_grant' : 'idp.role_revoke',
      targetType: 'user',
      targetId: userId,
      detail: { role: body.role },
    });
  return accessView(ctx, userId);
}

/**
 * Takes a role the owner added in Polaris ID (an external one) away anyway. The binding allows it only as an
 * override, within its own budget. 409 when the role is not one PassBook found there.
 */
export async function removeExternalRole(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
  role: WritableRole,
): Promise<AccessView> {
  needBinding(ctx);
  await nonAdmin(ctx, userId);
  const found = (await statesOfUser(ctx.env.DB, userId)).find(
    (s) => s.target === role && s.observed === 1 && s.presence === 'external',
  );
  if (!found) throw new ConflictError('This role was not added in Polaris ID.', 'IDP_NOT_EXTERNAL');
  const result = await idpClient(ctx.env, ctx.log).apply(
    found.subject,
    { remove: [role] },
    {
      ref: `external-${ctx.requestId ?? ctx.ids.id()}`,
      reason: 'remove_external',
      actor: { kind: actor.type === 'user' ? 'user' : 'key', id: actor.id },
      override: true,
    },
  );
  if (!result.dryRun && result.removed.includes(role)) {
    await removedTarget(ctx, { subject: found.subject, userId }, role, 'removed_anyway');
    await recordAudit(ctx, {
      actorType: actor.type,
      actorId: actor.id,
      action: 'idp.remove_external',
      targetType: 'user',
      targetId: userId,
      detail: { role },
    });
  }
  return accessView(ctx, userId);
}

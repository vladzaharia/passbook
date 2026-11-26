import type { MiddlewareHandler } from 'hono';
import type { Actor } from '../../platform/actor.ts';
import type { AppBindings } from '../../platform/context.ts';
import { reportDenied } from '../../platform/denied.ts';
import { AppError, ForbiddenError } from '../../platform/errors.ts';
import { activeCreatorOfKey } from './repo-key-creator.ts';
import type { Actor as BindingActor } from './types.ts';

/** Who the binding's ledger names: the person, or the key. */
export const bindingActorOf = (actor: Actor): BindingActor => ({
  kind: actor.actorType === 'user' ? 'user' : 'key',
  id: actor.actorId,
});

/**
 * The user an `*_by` column records. Those columns name a user, so a Platform key's rows name the person who
 * minted it, who must still be active; the audit row names the key.
 */
export async function byUserOf(db: D1Database, actor: Actor): Promise<string> {
  if (actor.userId) return actor.userId;
  if (!actor.keyId) throw new ForbiddenError();
  const row = await activeCreatorOfKey(db, actor.keyId);
  if (!row) throw new ForbiddenError('The key has no active creator.', 'FORBIDDEN');
  return row.created_by;
}

/** The audit actor of a call. */
export const auditActorOf = (actor: Actor) => ({
  actorType: actor.actorType,
  actorId: actor.actorId,
});

const reported = new WeakSet<Request>();

/** A key reaching for a platform admin is an escalation attempt: audited as the key, ids only, once per request. */
export const reportKeyAdminRefusal: MiddlewareHandler<AppBindings> = async (c, next) => {
  await next();
  const auth = c.var.auth;
  if (
    !reported.has(c.req.raw) &&
    auth?.kind === 'api_key' &&
    c.error instanceof AppError &&
    c.error.code === 'IDP_PLATFORM_ADMIN'
  ) {
    reported.add(c.req.raw);
    reportDenied(c, 'IDP_PLATFORM_ADMIN', auth);
  }
};

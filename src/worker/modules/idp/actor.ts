import type { Actor } from '../../platform/actor.ts';
import { ForbiddenError } from '../../platform/errors.ts';
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

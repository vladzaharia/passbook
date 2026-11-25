import { PERSONAL_ORG_COPY } from '../../../shared/copy/personal-org.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { personalOwnerOf } from './repo-personal.ts';

/**
 * A personal org belongs to its owner: platform-scope management of it (plan, features, status,
 * close or reopen, the directory page) is refused unless the actor is that owner.
 */
export function requirePersonalOwner(personalUserId: string | null, actorUserId: string): void {
  if (personalUserId !== null && personalUserId !== actorUserId)
    throw new ForbiddenError(PERSONAL_ORG_COPY.platformRefused, 'ORG_PERSONAL');
}

/** The same check by org id; an unknown org passes, for the caller's own not-found. */
export async function requireNotPersonalFor(
  db: D1Database,
  orgId: string,
  actorUserId: string,
): Promise<void> {
  requirePersonalOwner(await personalOwnerOf(db, orgId), actorUserId);
}

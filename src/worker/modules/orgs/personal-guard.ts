import { PERSONAL_ORG_COPY } from '../../../shared/copy/personal-org.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { personalOwnerOf, suspendedBy } from './repo-personal.ts';

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

/**
 * Status of a personal org. Any platform admin may suspend one (break-glass). The owner lifts only a
 * suspension they placed; another admin may lift any.
 */
export async function requirePersonalStatusMove(
  db: D1Database,
  org: { id: string; personal_user_id: string | null },
  to: 'active' | 'suspended',
  actorUserId: string,
): Promise<void> {
  if (org.personal_user_id === null || to === 'suspended') return;
  if (actorUserId === org.personal_user_id && (await suspendedBy(db, org.id)) !== actorUserId)
    throw new ForbiddenError(PERSONAL_ORG_COPY.suspendedByPlatform, 'ORG_PERSONAL');
}

/** Personal orgs are on Unlimited by rule: nobody, the owner included, writes their plan or overrides. */
export async function requireNotPersonal(db: D1Database, orgId: string): Promise<void> {
  if ((await personalOwnerOf(db, orgId)) !== null)
    throw new ForbiddenError(PERSONAL_ORG_COPY.planFixed, 'ORG_PERSONAL');
}

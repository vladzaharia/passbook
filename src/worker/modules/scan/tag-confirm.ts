import { TAG_CONFIRM_FLAG } from '../../../shared/copy/tags.ts';
import { candidateTypeFit, sessionTakesType } from '../nfc/policy.ts';
import type { ScanActor } from './guard.ts';
import type { Candidate } from './repo-lookup.ts';
import type { Waive } from './resolve-policy.ts';
import { ROLE_RANK } from './rules.ts';

/** The tag's type, in the session's types and fitting the candidate's template and uses. */
export const tagTypeHolds = (actor: ScanActor, c: Candidate): boolean => {
  const type = actor.tag?.type ?? null;
  return sessionTakesType(actor.settings.tags?.types, type) && candidateTypeFit(c, type) === 'ok';
};

/**
 * The check a tap still needs before it lets someone in (design 2.1): `staff` is a Desk confirming with the
 * card on screen, so a Door cannot confirm its own scan; `manager` is a Manager's PIN, or a Manager at the
 * scanner. Null once it is done or when the tag asks nothing.
 */
export function tagCheck(
  actor: ScanActor,
  waive: Waive,
): { kind: 'staff' | 'manager'; flag: string } | null {
  const tag = actor.tag;
  const confirm = tag?.confirm ?? 'none';
  if (!tag || confirm === 'none') return null;
  const flag = TAG_CONFIRM_FLAG[tag.assurance];
  if (confirm === 'staff')
    return waive.confirmed && actor.role !== null && ROLE_RANK[actor.role] >= ROLE_RANK.desk
      ? null
      : { kind: 'staff', flag };
  return waive.approved || actor.role === 'manager' ? null : { kind: 'manager', flag };
}

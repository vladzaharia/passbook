import type { OrgMembership } from '@/shared/contracts/org-membership.ts';

/** A developer sandbox belongs to the developer portal; its membership carries `testOnly`. */
export const isSandbox = (membership: Pick<OrgMembership, 'testOnly'>): boolean =>
  membership.testOnly === true;

/**
 * The memberships admin offers as "your organizations": the switcher, the /admin chooser, ⌘K and
 * the remembered-scope redirect. Sandboxes stay out; a link or URL that names one still opens it,
 * so grants themselves are never filtered with this.
 */
export function listableMemberships<T extends Pick<OrgMembership, 'testOnly'>>(
  memberships: readonly T[],
): T[] {
  return memberships.filter((m) => !isSandbox(m));
}

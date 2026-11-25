import type { OrgMembership, OrgRole } from '@/shared/contracts/org-membership.ts';
import { ROLE_LABELS } from '../../admin/orgs/org-roles.ts';
import { canAccessAdminPath } from '../../lib/guards.ts';
import { firstAllowedPath } from '../../lib/nav.ts';
import { type AdminScope, orgPath, platformPath } from '../../lib/scope.ts';

/** One card on the chooser: an organization, or the platform for a platform admin. */
export type Choice =
  | { kind: 'org'; key: string; name: string; to: string; last: boolean; membership: OrgMembership }
  | { kind: 'platform'; key: string; name: string; to: string; last: boolean };

/**
 * Developer sandboxes (org kind 'developer': `testOnly` on a membership) are not offered. One
 * place, so the shared scope filter can take it over.
 */
export function chooserMemberships(memberships: readonly OrgMembership[]): OrgMembership[] {
  return memberships.filter((m) => !m.testOnly);
}

/** The section asked for in the chosen organization, else the first one its roles open. */
export function chooserTarget(membership: OrgMembership, next: string): string {
  const wanted = orgPath(membership.orgId, next);
  if (canAccessAdminPath(wanted, false, membership)) return wanted;
  const scope: AdminScope = { kind: 'org', orgId: membership.orgId };
  return firstAllowedPath(scope, false, membership) ?? orgPath(membership.orgId);
}

/**
 * Last used first, then the platform (admins), the personal organization and the rest in the
 * grants' order, as the scope switcher lists them.
 */
export function orderChoices(
  memberships: readonly OrgMembership[],
  opts: { next: string; platform: boolean; last: AdminScope | undefined },
): Choice[] {
  const { last } = opts;
  const lastOrg = last?.kind === 'org' ? last.orgId : undefined;
  const choices: Choice[] = [];
  if (opts.platform) {
    choices.push({
      kind: 'platform',
      key: 'platform',
      name: 'Platform',
      to: platformPath(),
      last: last?.kind === 'platform',
    });
  }
  const personalFirst = [...memberships].sort((a, b) => Number(b.personal) - Number(a.personal));
  for (const membership of personalFirst) {
    choices.push({
      kind: 'org',
      key: membership.orgId,
      name: membership.orgName,
      to: chooserTarget(membership, opts.next),
      last: membership.orgId === lastOrg,
      membership,
    });
  }
  const lead = choices.findIndex((c) => c.last);
  if (lead > 0) choices.unshift(...choices.splice(lead, 1));
  return choices;
}

/** Name or slug, case-insensitive. */
export function matchesChoice(choice: Choice, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const slug = choice.kind === 'org' ? choice.membership.orgSlug : '';
  return choice.name.toLowerCase().includes(q) || slug.toLowerCase().includes(q);
}

/** "Template author, Pass operator +1": two roles, then a count. */
export function rolesLine(roles: readonly OrgRole[]): string {
  const shown = roles.slice(0, 2).map((r) => ROLE_LABELS[r]);
  const more = roles.length - shown.length;
  return more > 0 ? `${shown.join(', ')} +${more}` : shown.join(', ');
}

/**
 * Where an arrow key moves in a grid of `count` cards laid out `cols` wide: an index, 'up' (out
 * of the first row, to the filter above), or undefined (not a grid key). Down from a row with a
 * shorter row under it lands on the last card.
 */
export function gridStep(
  key: string,
  index: number,
  count: number,
  cols: number,
): number | 'up' | undefined {
  const last = count - 1;
  switch (key) {
    case 'ArrowRight':
      return Math.min(index + 1, last);
    case 'ArrowLeft':
      return Math.max(index - 1, 0);
    case 'ArrowDown': {
      if (Math.floor(index / cols) === Math.floor(last / cols)) return index;
      return Math.min(index + cols, last);
    }
    case 'ArrowUp':
      return index < cols ? 'up' : index - cols;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return undefined;
  }
}

/** Cards in the first row: they share its top edge. */
export function columnsOf(items: readonly HTMLElement[]): number {
  const top = items[0]?.getBoundingClientRect().top;
  const cols = items.filter((el) => Math.abs(el.getBoundingClientRect().top - (top ?? 0)) < 2);
  return Math.max(1, cols.length);
}

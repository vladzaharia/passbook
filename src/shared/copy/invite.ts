import type { OrgRole } from '../contracts/org-membership.ts';

/** The invitation, said the same in its email and on the page its link opens. */
const ROLE_PHRASE: Record<OrgRole, string> = {
  org_admin: 'an organization admin',
  integration_admin: 'an integrations admin',
  template_author: 'a template author',
  template_reviewer: 'a template reviewer',
  template_publisher: 'a template publisher',
  pass_operator: 'a pass operator',
  read_only: 'a read-only member',
};

/** "an organization admin" / "a pass operator and a template author". */
export function rolesPhrase(roles: readonly string[]): string {
  const phrases = roles.map((r) => ROLE_PHRASE[r as OrgRole]).filter(Boolean);
  return phrases.length ? phrases.join(' and ') : 'a member';
}

/** The email's lead line; `inviter` is the person's name when they have one. */
export const inviteLine = (orgName: string, roles: readonly string[], inviter?: string | null) =>
  `${inviter ? `${inviter} invited you` : 'You are invited'} to ${orgName} as ${rolesPhrase(roles)}.`;

export const INVITE_COPY = {
  title: (orgName: string) => `Join ${orgName}`,
  accept: 'Accept and sign in',
  lede: (roles: readonly string[]) => `As ${rolesPhrase(roles)}.`,
} as const;

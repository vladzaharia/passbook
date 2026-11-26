import { INVITE_EMAIL, invitedBy, rolesPhrase } from './invite.ts';

/** The developer invitation email (dev-invite-design.md 5.4). */
export const DEVELOPER_INVITE_EMAIL = {
  subject: (orgName: string) => `Developer invitation from ${orgName}`,
  title: (orgName: string) => `Build for ${orgName}`,
  line: (orgName: string, roles: readonly string[], inviter?: string | null) =>
    `${invitedBy(inviter)} to develop for ${orgName} on PassBook.${
      roles.length ? ` You also join as ${rolesPhrase(roles)}.` : ''
    }`,
  ...INVITE_EMAIL,
} as const;

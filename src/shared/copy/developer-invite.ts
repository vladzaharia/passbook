import { rolesPhrase } from './invite.ts';

/** The developer invitation email (dev-invite-design.md 5.4). */
export const DEVELOPER_INVITE_EMAIL = {
  subject: (orgName: string) => `Developer invitation from ${orgName}`,
  title: (orgName: string) => `Build for ${orgName}`,
  line: (orgName: string, roles: readonly string[], inviter?: string | null) =>
    `${inviter ? `${inviter} invited you` : 'You are invited'} to develop for ${orgName} on PassBook.${
      roles.length ? ` You also join as ${rolesPhrase(roles)}.` : ''
    }`,
  button: 'Accept invitation',
  footer: 'Expires in seven days. Ignore this email if you did not expect it.',
} as const;

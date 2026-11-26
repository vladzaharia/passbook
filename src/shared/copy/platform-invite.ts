import { INVITE_EMAIL, invitedBy } from './invite.ts';

/** The platform invitation email: access to Polaris ID groups, and developer access when chosen. */
export const PLATFORM_INVITE_EMAIL = {
  subject: 'You are invited to PassBook',
  title: 'Your invitation',
  line: (developer: boolean, inviter?: string | null) =>
    `${invitedBy(inviter)} to Polaris ID access${
      developer ? ' and PassBook developer access' : ''
    }.`,
  ...INVITE_EMAIL,
} as const;

/** The platform invitation email: access to Polaris ID groups, and developer access when chosen. */
export const PLATFORM_INVITE_EMAIL = {
  subject: 'You are invited to PassBook',
  title: 'Your invitation',
  line: (developer: boolean, inviter?: string | null) =>
    `${inviter ? `${inviter} invited you` : 'You are invited'} to Polaris ID access${
      developer ? ' and PassBook developer access' : ''
    }.`,
  button: 'Accept invitation',
  footer: 'Expires in seven days. Ignore this email if you did not expect it.',
} as const;

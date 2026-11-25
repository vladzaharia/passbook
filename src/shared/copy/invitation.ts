import { rolesPhrase } from './invite.ts';

/** The invitation page, for member and developer invitations alike. The email says the same things in its own words. */
export const INVITATION_COPY = {
  invalid: 'This invitation is invalid or expired. Ask for a new one.',
  title: (kind: 'member' | 'developer', orgName: string) =>
    kind === 'developer' ? `Build for ${orgName}` : `Join ${orgName}`,
  lede: (kind: 'member' | 'developer', roles: readonly string[]) =>
    kind === 'developer'
      ? `Developer access with your own sandbox.${roles.length ? ` You also join as ${rolesPhrase(roles)}.` : ''}`
      : `As ${rolesPhrase(roles)}.`,
  address: (masked: string) => `For ${masked}.`,
  signInLine: 'Sign in with Polaris ID to join {org}.',
  create: 'Create a Polaris ID',
  have: 'I have a Polaris ID',
  signIn: 'Sign in with Polaris ID',
  accept: 'Accept invitation',
  afterSetup: 'In Polaris ID, add a passkey and confirm your email. Then sign in here.',
  noAccount: 'No Polaris ID uses this address. Create one.',
  refresh: 'One more sign-in to finish.',
  joined: (kind: 'member' | 'developer', orgName: string) =>
    kind === 'developer' ? 'You have developer access.' : `Joined ${orgName}`,
  openAdmin: 'Open admin',
  openDevelopers: 'Open Developers',
  failed: 'Something went wrong. Try again.',
} as const;

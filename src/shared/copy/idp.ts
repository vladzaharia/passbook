/** Words for the Polaris ID screens: the Access card, Offboard, groups, claims and the Invite wizard. */
export const IDP_COPY = {
  role: {
    console: 'Console',
    developer: 'Developer',
    support: 'Support',
  },
  account: {
    created: 'Created by PassBook',
    linked: 'Existing account',
    external: 'Added in Polaris ID',
    none: 'No account yet',
    disabled: 'Disabled in Polaris ID',
  },
  paused: 'Paused in Polaris ID',
  accessPaused: 'Access paused',
  noClaims: 'No claims.',
  noGroups: 'No custom groups.',
  claimsReach: 'Claims reach every app that signs in with Polaris ID.',
  inviteForwarded: "This account doesn't use the invited address.",
  inviteUnverified: 'Confirm your email in Polaris ID, then try again.',
  dryRun: 'Dry run: nothing was sent to Polaris ID.',
} as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const idpPlural = plural;

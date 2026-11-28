// Split from sign-in.ts so the Workbench shell's user menu does not pull the whole sign-in table.

/** The SSR auth pages' labels (worker/modules/auth/pages.ts). */
export const AUTH_PAGE_COPY = {
  signIn: 'Sign in',
  signInPolarisId: 'Sign in with Polaris ID',
  backToSignIn: 'Back to sign in',
  signInToConfirm: 'Sign in to confirm',
  confirmEmail: 'Confirm email',
  confirm: 'Confirm',
  otherAccount: 'This browser is signed in to another account.',
  emailInstead: 'Sign in with email instead',
  otherPolarisId: 'Use another Polaris ID',
  breakglass: 'Break-glass sign-in',
  token: 'Token',
  signingOut: 'Signing out',
  continue: 'Continue',
  confirmSignIn: 'Confirm sign-in',
  emailNewLink: 'Email me a new link',
  openPassBook: 'Open PassBook',
  checkEmail: 'Check your email',
  breakglassLede: 'Emergency access for platform admins. Use is logged.',
} as const;

/** An email-link session at a space that needs Polaris ID (shared/spaces.ts). A separate export: the scanner bundles AUTH_PAGE_COPY. */
export const POLARIS_ID_COPY = {
  needs: (space: string) => `${space} needs Polaris ID.`,
  signIn: 'Sign in with Polaris ID',
} as const;

import { EMAIL_INVALID_MESSAGE } from '../email.ts';
import { HOLDER_COPY } from './holder.ts';
import { STATE_COPY, waitLine } from './states.ts';

// Sign-in copy, shared by /login (SPA) and the worker's SSR auth pages.

/** The lock line under the sign-in card. */
export const SIGN_IN_FOOTER = HOLDER_COPY.signInFooter;

export const INVALID_EMAIL = EMAIL_INVALID_MESSAGE;
export const WRONG_CODE = 'That code is wrong or expired.';
const LINK_EXPIRED = 'Link expired';

/** One line on /login for `?reason=`. */
export const LOGIN_REASONS = {
  expired: 'Your session ended. Sign in again.',
} as const;
export type LoginReason = keyof typeof LOGIN_REASONS;

export type SignInErrorCode =
  | 'NO_ACCESS'
  | 'ACCOUNT_DISABLED'
  | 'NO_EMAIL'
  | 'EMAIL_UNVERIFIED'
  | 'EMAIL_CONFLICT'
  | 'EMAIL_PROOF_SENT'
  | 'SESSION_REQUIRED'
  | 'LINK_INVALID'
  | 'EMAIL_TAKEN'
  | 'MAGIC_LINK_DISABLED'
  | 'RATE_LIMITED'
  | 'VALIDATION';

/** A refused or failed sign-in, by the server's error code: a title and one sentence. */
export const SIGN_IN_ERROR_COPY: Record<SignInErrorCode, { title: string; message: string }> = {
  NO_ACCESS: {
    title: STATE_COPY.forbidden,
    message: 'This Polaris ID account cannot use PassBook.',
  },
  ACCOUNT_DISABLED: {
    title: 'Account disabled',
    message: 'Contact the organization that sent your pass.',
  },
  NO_EMAIL: {
    title: 'No email',
    message: 'The account has no email address. Add one in Polaris ID.',
  },
  EMAIL_UNVERIFIED: {
    title: 'Email not verified',
    message: 'Verify your email in Polaris ID, or sign in with an email link instead.',
  },
  EMAIL_CONFLICT: {
    title: 'Email in use',
    message: 'This email belongs to another account. Sign in with an email link first.',
  },
  EMAIL_PROOF_SENT: {
    title: 'Check your email',
    message: 'We emailed you a link. Open it in this browser to continue.',
  },
  SESSION_REQUIRED: {
    title: 'Sign in first',
    message: 'Sign in to the account that asked for this link, then confirm.',
  },
  LINK_INVALID: {
    title: LINK_EXPIRED,
    message: 'This link or code is invalid or expired. Request a new one.',
  },
  EMAIL_TAKEN: { title: 'Email in use', message: 'That address belongs to another account.' },
  MAGIC_LINK_DISABLED: { title: 'Email sign-in is off', message: 'Sign in another way.' },
  RATE_LIMITED: { title: STATE_COPY.rateLimited, message: waitLine() },
  VALIDATION: { title: 'Sign-in failed', message: 'The request was incomplete. Start again.' },
};

/** A Polaris ID round trip that did not finish. */
export const OIDC_FAILURE_COPY = {
  cancelled: { title: 'Sign-in failed', message: 'Sign-in was cancelled or refused. Try again.' },
  expired: { title: 'Sign-in expired', message: 'Start again.' },
  unverified: {
    title: 'Sign-in failed',
    message: 'The sign-in could not be verified. Try again.',
  },
  unavailable: {
    title: 'Sign-in unavailable',
    message: 'The sign-in provider failed. Try again.',
  },
} as const;
export type OidcFailure = keyof typeof OIDC_FAILURE_COPY;

/** The SSR auth pages' labels (worker/modules/auth/pages.ts). */
export const AUTH_PAGE_COPY = {
  signIn: 'Sign in',
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
} as const;

/** A dead link, by what it was for: an add-email link is no way to sign in. */
export const EXPIRED_LINK_COPY = {
  sign_in: {
    title: LINK_EXPIRED,
    message: 'Request a new one to sign in.',
    action: AUTH_PAGE_COPY.backToSignIn,
  },
  verify_email: {
    title: LINK_EXPIRED,
    message: 'Add the email again in Account.',
    action: 'Go to Account',
  },
} as const;

export function isSignInErrorCode(code: string): code is SignInErrorCode {
  return Object.hasOwn(SIGN_IN_ERROR_COPY, code);
}

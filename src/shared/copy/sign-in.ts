/** Sign-in copy, shared by /login (SPA) and the worker's SSR auth pages. */

/** The lock line under the sign-in card. */
export const SIGN_IN_FOOTER = 'Signing in shows the passes sent to your email.';

export const INVALID_EMAIL = 'Enter a valid email address.';
export const WRONG_CODE = 'That code is wrong or expired.';

/** One line on /login for `?reason=`. */
export const LOGIN_REASONS = {
  expired: 'Your session ended. Sign in again.',
} as const;
export type LoginReason = keyof typeof LOGIN_REASONS;

export type SignInErrorCode =
  | 'NO_ACCESS'
  | 'ACCOUNT_DISABLED'
  | 'NO_EMAIL'
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
  NO_ACCESS: { title: 'No access', message: 'This Polaris ID account cannot use PassBook.' },
  ACCOUNT_DISABLED: {
    title: 'Account disabled',
    message: 'This account is disabled. Ask an admin.',
  },
  NO_EMAIL: {
    title: 'No email',
    message: 'The account has no email address. Add one in Polaris ID.',
  },
  EMAIL_CONFLICT: {
    title: 'Email in use',
    message: 'This email belongs to another account. Sign in with an email link first.',
  },
  EMAIL_PROOF_SENT: {
    title: 'Check your email',
    message: 'This email belongs to an existing account. Open the link we sent, in this browser.',
  },
  SESSION_REQUIRED: {
    title: 'Sign in first',
    message: 'Sign in to the account that asked for this link, then confirm.',
  },
  LINK_INVALID: {
    title: 'Link expired',
    message: 'This link or code is invalid or expired. Request a new one.',
  },
  EMAIL_TAKEN: { title: 'Email in use', message: 'That address belongs to another account.' },
  MAGIC_LINK_DISABLED: { title: 'Email sign-in is off', message: 'Sign in another way.' },
  RATE_LIMITED: { title: 'Too many requests', message: 'Try again in a minute.' },
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

export function isSignInErrorCode(code: string): code is SignInErrorCode {
  return Object.hasOwn(SIGN_IN_ERROR_COPY, code);
}

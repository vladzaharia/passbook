import { EMAIL_INVALID_MESSAGE } from '../email.ts';
import { AUTH_PAGE_COPY, POLARIS_ID_COPY } from './auth-page.ts';
import { HOLDER_COPY } from './holder.ts';
import { STATE_COPY, waitLine } from './states.ts';

// Sign-in copy, shared by /login (SPA) and the worker's SSR auth pages.

/** The lock line under the sign-in card. */
export const SIGN_IN_FOOTER = HOLDER_COPY.signInFooter;

/** After a sign-in request: the same for every address, known or not. */
export const SIGN_IN_SENT =
  'If this address has a pass or an invitation, a link is on its way. Nothing yet? Use the address your pass was sent to.';

/** 403 IDP_SIGN_IN_REQUIRED: the console and developer tools are not open to an email-link sign-in. */
export const IDP_SIGN_IN_REQUIRED_MESSAGE = 'Sign in with Polaris ID to continue.';
export { STEP_UP_REQUIRED_MESSAGE } from './step-up-message.ts';
/** The invitation page for someone without a Polaris ID session; `{org}` is the organization's name. */
export const INVITE_SIGN_IN_LINE = 'Sign in with Polaris ID to join {org}.';
/** The admin shell's line for an email session still inside the console grace window. */
export const graceLine = (date: string) => `Use Polaris ID by ${date} to keep Admin access.`;
/** A Polaris ID email that is only a secondary address of a PassBook account; `masked` is its main email. */
export const idpEmailNotPrimaryLine = (masked: string) =>
  `This Polaris ID email isn't your PassBook account's main email. Change it in Polaris ID to ${masked}.`;
/** The proof mail for linking a Polaris ID account to an existing PassBook account. */
export const IDENTITY_LINK_MAIL_LINE =
  "A Polaris ID account is being linked to your PassBook account. If this wasn't you, ignore this email. Never share this code.";
export const IDENTITY_LINKED_SUBJECT = 'Polaris ID linked';
export const IDENTITY_LINKED_BODY = 'Polaris ID was linked to your PassBook account.';
export const PASSKEY_REQUIRED_MESSAGE = 'Sign in to Polaris ID with your passkey, not a code.';

export const INVALID_EMAIL = EMAIL_INVALID_MESSAGE;
export const WRONG_CODE = 'That code is wrong or expired.';
const LINK_EXPIRED = 'Link expired';

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
  | 'PASSKEY_REQUIRED'
  | 'IDP_EMAIL_NOT_PRIMARY'
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
  PASSKEY_REQUIRED: { title: 'Use your passkey', message: PASSKEY_REQUIRED_MESSAGE },
  IDP_EMAIL_NOT_PRIMARY: {
    title: 'Wrong email',
    message: idpEmailNotPrimaryLine('your main email'),
  },
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

export { AUTH_PAGE_COPY, POLARIS_ID_COPY };

/**
 * A dead link, by what it was for and how it died. A sign-in link can be resent to the address it
 * was for; an invitation's cannot (a fresh sign-in would not join the org), so it points to the admin.
 */
export const EXPIRED_LINK_COPY = {
  sign_in: {
    title: LINK_EXPIRED,
    message: 'Request a new one to sign in.',
    action: AUTH_PAGE_COPY.backToSignIn,
  },
  used: {
    title: 'Link already used',
    message:
      'Each link works once. If you are signed in, open PassBook. Otherwise request a new one.',
    action: AUTH_PAGE_COPY.backToSignIn,
  },
  invitation: {
    title: 'Invitation expired',
    message: 'Ask the organization admin to send a new invitation.',
    action: AUTH_PAGE_COPY.backToSignIn,
  },
  invitation_pending: {
    title: 'Invitation pending',
    message: 'Sign in with this address to accept.',
    action: AUTH_PAGE_COPY.signIn,
  },
  invitation_used: {
    title: 'Invitation already used',
    message: 'If you are signed in, open PassBook. Otherwise sign in with this address.',
    action: AUTH_PAGE_COPY.backToSignIn,
  },
  verify_email: {
    title: LINK_EXPIRED,
    message: 'Add the email again in Account.',
    action: 'Go to Account',
  },
} as const;

/** After "Email me a new link": the same answer for every address. */
export const RESENT_COPY = {
  title: AUTH_PAGE_COPY.checkEmail,
  message: 'If a new link can be sent, it is on its way. It works for 15 minutes.',
} as const;

export function isSignInErrorCode(code: string): code is SignInErrorCode {
  return Object.hasOwn(SIGN_IN_ERROR_COPY, code);
}

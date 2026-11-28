// The sign-in page's `?reason=` lines. Apart from sign-in.ts: the scanner bundles that file.

/** One line on /login for `?reason=`. */
export const LOGIN_REASONS = {
  expired: 'Your session ended. Sign in again.',
  /** From a pass page's "My passes" row (H5). */
  pass: 'Use the email this pass was sent to.',
  /** From a dead pass link. */
  link: 'That pass link does not work. Sign in to see your current passes.',
  /** An email session sent to Admin or Developers. */
  polaris: 'Email links open My passes only. Use Polaris ID.',
} as const;
export type LoginReason = keyof typeof LOGIN_REASONS;
export const LOGIN_REASON_KEYS = Object.keys(LOGIN_REASONS) as [LoginReason, ...LoginReason[]];

/** The sign-in page's operator layout: Polaris ID first, email for pass holders. */
export const LOGIN_OPERATOR_COPY = {
  holderLine: 'Pass holder? Email links open My passes only.',
} as const;

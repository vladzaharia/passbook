const MESSAGES: Record<string, string> = {
  not_in_group: 'Your Polaris ID is not allowed to use PassBook.',
  expired_link: 'That link expired. Request a new one.',
  invalid_link: 'That link is invalid or already used. Request a new one.',
  used_link: 'That link was already used. Request a new one.',
  access_denied: 'Sign-in was cancelled.',
  rate_limited: 'Too many attempts. Try again later.',
};

/** One line for an `?error=` code from the auth redirects; unknown codes get a generic line. */
export function loginErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? 'Sign-in failed. Try again.';
}

/**
 * Words for not-found, forbidden and error states. The SPA (ui/empty-state, ui/error-state,
 * lib/errors) and the SSR pages read the same strings.
 */
export const STATE_COPY = {
  pageNotFound: 'Page not found',
  forbidden: 'You do not have access',
  /** The way out of a forbidden page: sign out, then sign in with another account. */
  switchAccount: 'Sign in as someone else',
  goToMyPasses: 'Go to My passes',
  goToOverview: 'Go to Overview',
  /** The generic failure: a 5xx, or anything without a message of its own. */
  error: 'Something went wrong. Try again.',
  network: 'Network error. Check your connection.',
  /** The response did not match the app's schema: a reload fetches the current app. */
  badResponse: 'Could not read the response. Reload.',
  retry: 'Retry',
} as const;

/** "Pass not found". `label` is the entity's singular label, as shown ("Apple identity"). */
export const notFoundTitle = (label: string): string => `${label} not found`;

/** "Back to passes": the way from a missing item to its list. `plural` as shown in prose. */
export const backTo = (plural: string): string => `Back to ${plural}`;

/** The forbidden state as a sentence, for error messages. */
export const FORBIDDEN_MESSAGE = `${STATE_COPY.forbidden}.`;

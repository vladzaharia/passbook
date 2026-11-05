/**
 * Words for not-found, forbidden and error states. The SPA (ui/empty-state, ui/error-state,
 * ui/layout/error-pages, lib/errors) and the SSR pages (ssr/error-page, auth/pages) read the same
 * strings.
 */
const ERROR_TITLE = 'Something went wrong';
const TRY_AGAIN = 'Try again.';

export const STATE_COPY = {
  pageNotFound: 'Page not found',
  forbidden: 'You do not have access',
  /** The way out of a forbidden page: sign out, then sign in with another account. */
  switchAccount: 'Sign in as someone else',
  goToMyPasses: 'Go to My passes',
  /** Under the 404 and 403 titles on the hosted pages. */
  notFoundLine: 'Check the link, or open My passes.',
  forbiddenLine: 'Sign in with the account that has access.',
  goToOverview: 'Go to Overview',
  search: 'Search',
  /** The generic failure: a 5xx, or anything without a message of its own. */
  error: `${ERROR_TITLE}. ${TRY_AGAIN}`,
  /** The same failure as a page's h1 (SSR), with `tryAgain` under it. */
  errorTitle: ERROR_TITLE,
  tryAgain: TRY_AGAIN,
  rateLimited: 'Too many requests',
  network: 'Could not reach PassBook. Check your connection.',
  /** A page's code did not load: offline, or a deploy replaced it. */
  pageLoadFailed: 'Could not load this page. Check your connection.',
  /** The response did not match the app's schema: a reload fetches the current app. */
  badResponse: 'Could not read the response. Reload.',
  retry: 'Retry',
  reload: 'Reload',
} as const;

/** "Pass not found". `label` is the entity's singular label, as shown ("Apple identity"). */
export const notFoundTitle = (label: string): string => `${label} not found`;

/** "Back to passes": the way from a missing item to its list. `plural` as shown in prose. */
export const backTo = (plural: string): string => `Back to ${plural}`;

/** The forbidden state as a sentence, for error messages. */
export const FORBIDDEN_MESSAGE = `${STATE_COPY.forbidden}.`;

/** How long a rate limit asks to wait, from its Retry-After seconds. */
export function waitLine(seconds?: number | null): string {
  if (!seconds || seconds <= 60) return 'Try again in a minute.';
  return `Try again in ${Math.ceil(seconds / 60)} minutes.`;
}

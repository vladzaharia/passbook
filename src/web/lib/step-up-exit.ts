import { safeNext } from './redirect.ts';

/** The server's sign-in URL, returning to `here` instead of the surface it guessed. */
export function stepUpHref(signInUrl: string, here: string): string {
  const url = new URL(signInUrl, 'http://step-up.invalid');
  url.searchParams.set('next', safeNext(here, '/'));
  return `${url.pathname}${url.search}`;
}

/** The one place the page leaves for Polaris ID (a seam for tests: jsdom cannot stub `location`). */
export const stepUpExit = {
  go: (href: string) => window.location.assign(href),
};

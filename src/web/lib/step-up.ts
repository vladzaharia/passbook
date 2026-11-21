import { useSyncExternalStore } from 'react';
import { safeNext } from './redirect.ts';

// A sensitive action answered STEP_UP_REQUIRED: the dialog asks the person to sign in again. The
// action is not replayed; they come back to the same page and click it again.
let pending: string | null = null;
const listeners = new Set<() => void>();

const set = (next: string | null) => {
  pending = next;
  for (const listener of listeners) listener();
};

/** Opens the step-up dialog. `signInUrl` is the server's, with `next` replaced by the current page at click time. */
export const requestStepUp = (signInUrl: string | undefined) =>
  set(signInUrl ?? '/auth/oidc/start?prompt=login&max_age=0');

export const dismissStepUp = () => set(null);

export function useStepUp(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
    () => null,
  );
}

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

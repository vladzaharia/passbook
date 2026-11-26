import { useSyncExternalStore } from 'react';

/**
 * The session behind the Workbench token ended (a 401 on the mint). The shell shows the one
 * "Sign in again" banner and keeps the page: drafts stay in `sessionStorage`, nothing retries.
 */
let gone = false;
const subs = new Set<() => void>();

export function markSessionGone(): void {
  if (gone) return;
  gone = true;
  for (const sub of subs) sub();
}

export function resetSessionGone(): void {
  if (!gone) return;
  gone = false;
  for (const sub of subs) sub();
}

export function useSessionGone(): boolean {
  return useSyncExternalStore(
    (sub) => {
      subs.add(sub);
      return () => subs.delete(sub);
    },
    () => gone,
    () => false,
  );
}

import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

export const MAIN_ID = 'main';

/** The tab title for a page: "<page> · PassBook". The announcer reads it when a page has no h1. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · PassBook`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** History moves that restore a page (Back, Forward, Go) rather than open a new one. */
const RESTORES = new Set(['BACK', 'FORWARD', 'GO']);

/**
 * Announces the page after navigation and moves focus to its h1 (or main) without scrolling.
 * Back and Forward leave focus alone, so the router's scroll restoration holds.
 */
export function RouteAnnouncer() {
  const router = useRouter();
  // The resolved location only changes once the new route's chunk and loaders are done.
  const pathname = useRouterState({
    select: (s) => (s.status === 'idle' ? s.resolvedLocation?.pathname : undefined),
  });
  const last = useRef<string | undefined>(undefined);
  const restoring = useRef(false);
  const [message, setMessage] = useState('');

  useEffect(
    () =>
      router.history.subscribe(({ action }) => {
        restoring.current = RESTORES.has(action.type);
      }),
    [router],
  );

  useEffect(() => {
    if (pathname === undefined) return;
    // A search-only change (?tab=, filters) passes through pending and back to the same path;
    // focus stays where the user put it. The first resolved path is the initial load.
    const previous = last.current;
    last.current = pathname;
    if (previous === undefined || previous === pathname) return;
    const restore = restoring.current;
    // Wait a frame so the new route has rendered its heading.
    const frame = requestAnimationFrame(() => {
      const main = document.getElementById(MAIN_ID);
      const heading = main?.querySelector<HTMLElement>('h1');
      if (!restore) (heading ?? main)?.focus({ preventScroll: true });
      setMessage(heading?.textContent?.trim() || document.title);
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {message}
    </div>
  );
}

export function SkipLink() {
  return (
    <a
      href={`#${MAIN_ID}`}
      onClick={(e) => {
        e.preventDefault();
        document.getElementById(MAIN_ID)?.focus();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-accent-on"
    >
      Skip to content
    </a>
  );
}

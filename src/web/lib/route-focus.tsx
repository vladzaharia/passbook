import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

export const MAIN_ID = 'main';

/** Moves focus to the page h1 (or main) after navigation and announces the page. */
export function RouteAnnouncer() {
  // The resolved location only changes once the new route's chunk and loaders are done.
  const pathname = useRouterState({
    select: (s) => (s.status === 'idle' ? s.resolvedLocation?.pathname : undefined),
  });
  const last = useRef<string | undefined>(undefined);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (pathname === undefined) return;
    // A search-only change (?tab=, filters) passes through pending and back to the same path;
    // focus stays where the user put it. The first resolved path is the initial load.
    const previous = last.current;
    last.current = pathname;
    if (previous === undefined || previous === pathname) return;
    // Wait a frame so the new route has rendered its heading.
    const frame = requestAnimationFrame(() => {
      const main = document.getElementById(MAIN_ID);
      const heading = main?.querySelector<HTMLElement>('h1');
      const target = heading ?? main;
      target?.focus({ preventScroll: false });
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

import type { ErrorComponentProps } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

const Pages = {
  NotFound: lazy(() => import('./error-pages.tsx').then((m) => ({ default: m.NotFoundPage }))),
  Route: lazy(() => import('./error-pages.tsx').then((m) => ({ default: m.RouteError }))),
  Standalone: lazy(() => import('./error-pages.tsx').then((m) => ({ default: m.StandaloneError }))),
};

/** The error and 404 pages (buddy art, copy, icons) load as one chunk on first use, not with the entry. */
export function NotFoundPage() {
  return (
    <Suspense fallback={null}>
      <Pages.NotFound />
    </Suspense>
  );
}

export function RouteError(props: ErrorComponentProps) {
  return (
    <Suspense fallback={null}>
      <Pages.Route {...props} />
    </Suspense>
  );
}

export function StandaloneError(props: ErrorComponentProps) {
  return (
    <Suspense fallback={null}>
      <Pages.Standalone {...props} />
    </Suspense>
  );
}

import type { ErrorComponentProps } from '@tanstack/react-router';
import { lazy } from 'react';
import { ChunkBoundary } from './chunk-boundary.tsx';

const Pages = {
  NotFound: lazy(() => import('./error-pages.tsx').then((m) => ({ default: m.NotFoundPage }))),
  Route: lazy(() => import('./error-pages.tsx').then((m) => ({ default: m.RouteError }))),
  Standalone: lazy(() => import('./error-pages.tsx').then((m) => ({ default: m.StandaloneError }))),
};

/** The error and 404 pages (buddy art, copy, icons) load as one chunk on first use, not with the entry. */
export function NotFoundPage() {
  return (
    <ChunkBoundary>
      <Pages.NotFound />
    </ChunkBoundary>
  );
}

export function RouteError(props: ErrorComponentProps) {
  return (
    <ChunkBoundary>
      <Pages.Route {...props} />
    </ChunkBoundary>
  );
}

export function StandaloneError(props: ErrorComponentProps) {
  return (
    <ChunkBoundary>
      <Pages.Standalone {...props} />
    </ChunkBoundary>
  );
}

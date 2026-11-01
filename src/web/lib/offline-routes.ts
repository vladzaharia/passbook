import { type ComponentType, createElement } from 'react';

type LazyComponent = ComponentType<Record<string, unknown>> & { preload?: () => Promise<void> };

/** A route chunk that cannot load while offline; RouteError keeps the shell and offers Reload. */
export class OfflineChunkError extends Error {
  constructor() {
    super('Failed to fetch dynamically imported module while offline');
    this.name = 'OfflineChunkError';
  }
}

const KINDS = ['component', 'errorComponent', 'pendingComponent', 'notFoundComponent'] as const;

/**
 * TanStack Router reloads the page once when a route chunk fails to load (a deploy replaced it).
 * Offline, that reload lands on the browser's error page, so an unloaded chunk throws instead and
 * the route error component renders inside the shell. Online behaviour is unchanged.
 */
export function offlineSafe(lazy: LazyComponent): LazyComponent {
  const Safe: LazyComponent = (props) => {
    // preload is cleared once the chunk has loaded.
    if (lazy.preload && typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new OfflineChunkError();
    }
    return createElement(lazy, props);
  };
  Safe.displayName = 'OfflineSafeRoute';
  Safe.preload = () => lazy.preload?.() ?? Promise.resolve();
  return Safe;
}

/** Wraps every code-split route component of a router in place. */
export function guardOfflineChunks(routes: Iterable<{ options: object }>) {
  for (const route of routes) {
    const options = route.options as Partial<Record<(typeof KINDS)[number], LazyComponent>>;
    for (const kind of KINDS) {
      const component = options[kind];
      if (component?.preload) options[kind] = offlineSafe(component);
    }
  }
}

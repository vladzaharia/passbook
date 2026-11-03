import type { QueryClient } from '@tanstack/react-query';
import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { viewTransitionOption } from './lib/motion.ts';
import { guardOfflineChunks } from './lib/offline-routes.ts';
import { routeTree } from './routeTree.gen.ts';
import { NotFoundPage, RouteError } from './ui/layout/error-pages.tsx';
import { SessionEnded } from './ui/session-ended.tsx';

export function createAppRouter(options: { queryClient: QueryClient; history?: RouterHistory }) {
  const router = createRouter({
    routeTree,
    history: options.history,
    context: { queryClient: options.queryClient },
    defaultPreload: 'intent',
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFoundPage,
    scrollRestoration: true,
    defaultViewTransition: viewTransitionOption(),
    // Inside the router, so its Sign in can pass the unsaved-changes blocker.
    InnerWrap: ({ children }) => (
      <>
        {children}
        <SessionEnded />
      </>
    ),
  });
  guardOfflineChunks(Object.values(router.routesById));
  return router;
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

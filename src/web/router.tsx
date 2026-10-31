import type { QueryClient } from '@tanstack/react-query';
import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen.ts';
import { NotFoundPage, RouteError } from './ui/layout/error-pages.tsx';

export function createAppRouter(options: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({
    routeTree,
    history: options.history,
    context: { queryClient: options.queryClient },
    defaultPreload: 'intent',
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFoundPage,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

import { createRootRouteWithContext, Outlet, useRouterState } from '@tanstack/react-router';
import { isAdminPath, isPublicPath, requireSession } from '../lib/guards.ts';
import type { RouterContext } from '../lib/router-context.ts';
import { RouteAnnouncer, SkipLink } from '../lib/route-focus.tsx';
import { BareLayout } from '../ui/layout/bare-layout.tsx';
import { StandaloneError } from '../ui/layout/error-pages.tsx';
import { PortalLayout } from '../ui/layout/portal-layout.tsx';

/** Picks the shell by path. Admin routes bring their own layout (routes/admin/route.tsx). */
function RootComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <>
      <SkipLink />
      <RouteAnnouncer />
      {isAdminPath(pathname) ? <Outlet /> : isPublicPath(pathname) ? <BareLayout /> : <PortalLayout />}
    </>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    if (isAdminPath(location.pathname) || isPublicPath(location.pathname)) return;
    await requireSession(context.queryClient, location.href);
  },
  component: RootComponent,
  errorComponent: StandaloneError,
});

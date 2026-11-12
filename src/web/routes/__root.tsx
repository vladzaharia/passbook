import { createRootRouteWithContext, Outlet, useRouterState } from '@tanstack/react-router';
import { Fragment, type ReactNode } from 'react';
import { isAdminPath, isPublicPath, requireSession } from '../lib/guards.ts';
import { RouteAnnouncer, SkipLink } from '../lib/route-focus.tsx';
import type { RouterContext } from '../lib/router-context.ts';
import { useSession } from '../lib/session.ts';
import { BareLayout } from '../ui/layout/bare-layout.tsx';
import { StandaloneError } from '../ui/layout/error-pages.tsx';
import { PortalLayout } from '../ui/layout/portal-layout.tsx';

/** Discard state and initial-data seeds when the authenticated principal changes. */
export function PrincipalBoundary({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const key = session?.authenticated
    ? `user:${session.user.id}`
    : session
      ? 'anonymous'
      : 'session-pending';
  return <Fragment key={key}>{children}</Fragment>;
}

/** Picks the shell by path. Admin routes bring their own layout (routes/admin/route.tsx). */
function RootComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <PrincipalBoundary>
      <SkipLink />
      <RouteAnnouncer />
      {isAdminPath(pathname) ? (
        <Outlet />
      ) : isPublicPath(pathname) ? (
        <BareLayout />
      ) : (
        <PortalLayout />
      )}
    </PrincipalBoundary>
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

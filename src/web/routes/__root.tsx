import { createRootRouteWithContext, Outlet, useRouterState } from '@tanstack/react-router';
import { Fragment, type ReactNode } from 'react';
import { isAdminPath, isKnownPortalPath, isPublicPath, requireSession } from '../lib/guards.ts';
import { RouteAnnouncer, SkipLink } from '../lib/route-focus.tsx';
import type { RouterContext } from '../lib/router-context.ts';
import { useSession } from '../lib/session.ts';
import { Skeleton } from '../ui/index.ts';
import { BareLayout } from '../ui/layout/bare-layout.tsx';
import { StandaloneError } from '../ui/layout/error-pages.tsx';
import { PortalLayout } from '../ui/layout/portal-layout.tsx';
import { StepUpGate } from '../ui/step-up-gate.tsx';

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
      <StepUpGate />
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

/**
 * Held while the session is fetched: a neutral page, never a blank one or the anonymous state of
 * the page behind it. Only past 150 ms, so a quick answer shows no flash.
 */
export function RootPending() {
  return (
    <div role="status" aria-busy className="grid min-h-dvh place-items-center bg-surface-page p-6">
      <span className="sr-only">Loading</span>
      <Skeleton className="aspect-[320/460] w-full max-w-[22rem] rounded-xl" />
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    if (isAdminPath(location.pathname) || isPublicPath(location.pathname)) return;
    // Unknown URLs fall through to the 404 page, which offers Sign in when signed out.
    if (!isKnownPortalPath(location.pathname)) return;
    await requireSession(context.queryClient, location.href);
  },
  component: RootComponent,
  pendingComponent: RootPending,
  pendingMs: 150,
  errorComponent: StandaloneError,
});

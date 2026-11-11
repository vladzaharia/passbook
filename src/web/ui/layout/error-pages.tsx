import { type ErrorComponentProps, Link, useRouter, useRouterState } from '@tanstack/react-router';
import { LayoutDashboard, LogIn, Search, WalletCards } from 'lucide-react';
import { useEffect } from 'react';
import { STATE_COPY } from '@/shared/copy/states.ts';
import { isApiError } from '../../lib/errors.ts';
import { isAdminPath } from '../../lib/guards.ts';
import { usePalette } from '../../lib/palette.ts';
import { signOut, useSession } from '../../lib/session.ts';
import { Button } from '../button.tsx';
import { EmptyState } from '../empty-state.tsx';
import { ErrorState, isChunkLoadError } from '../error-state.tsx';
import { AppShell } from './app-shell.tsx';
import { PortalBar } from './portal-layout.tsx';

// Words, art and action weights match the SSR pages (worker/ssr/error-page.tsx): outline ways back.

const useInAdmin = () => useRouterState({ select: (s) => isAdminPath(s.location.pathname) });

const ToMyPasses = () => (
  <Button variant="outline" asChild>
    <Link to="/">
      <WalletCards aria-hidden />
      {STATE_COPY.goToMyPasses}
    </Link>
  </Button>
);

export function ForbiddenPage() {
  const { authed } = useSession();
  // Switching accounts comes back here.
  const here = useRouterState({ select: (s) => s.location.href });
  // A holder who followed an admin link gets a way back to their passes.
  const holder = authed?.roles.includes('user') === true;
  return (
    <EmptyState
      heading
      art="lock"
      title={STATE_COPY.forbidden}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {holder ? <ToMyPasses /> : null}
          <Button
            variant="outline"
            iconStart={<LogIn aria-hidden />}
            onClick={() => void signOut(authed?.csrfToken, { next: here })}
          >
            {STATE_COPY.switchAccount}
          </Button>
        </div>
      }
    />
  );
}

/**
 * Signed in and in the organization, but the role does not cover this section: say which role
 * and organization, and offer the nearest section the membership does open.
 */
export function ScopedDeniedPage({
  orgName,
  section,
  entry,
}: {
  orgName: string;
  section: string | undefined;
  entry: { to: string; label: string | undefined; orgId: string };
}) {
  return (
    <EmptyState
      heading
      art="lock"
      title={STATE_COPY.forbidden}
      description={`${orgName}: your role does not include ${section ?? 'this section'}.`}
      action={
        <Button variant="outline" asChild>
          <Link to={entry.to} search={{ orgId: entry.orgId }}>
            <LayoutDashboard aria-hidden />
            {entry.label ? `Go to ${entry.label}` : 'Go to Account'}
          </Link>
        </Button>
      }
    />
  );
}

/** A route that is not there: the lost buddy peeks, as on the SSR 404. */
export function NotFoundPage() {
  const inAdmin = useInAdmin();
  const palette = usePalette();
  return (
    <EmptyState
      heading
      art="wallet"
      artState="lost"
      title={STATE_COPY.pageNotFound}
      action={
        inAdmin ? (
          <div className="flex flex-wrap justify-center gap-2">
            {palette ? (
              <Button variant="outline" iconStart={<Search aria-hidden />} onClick={palette.open}>
                {STATE_COPY.search}
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link to="/admin">
                <LayoutDashboard aria-hidden />
                {STATE_COPY.goToOverview}
              </Link>
            </Button>
          </div>
        ) : (
          <ToMyPasses />
        )
      }
    />
  );
}

/**
 * Route error component: 403 gets the forbidden page; a chunk that failed to load (offline,
 * deploy) asks for a reload and keeps the shell; everything else is an ErrorState.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const chunk = isChunkLoadError(error);
  // Back online, a page that failed for want of a network loads again with no click. Server
  // answers (API errors) are not network failures and wait for Retry.
  const offlineFailure = chunk || !isApiError(error);
  useEffect(() => {
    if (!offlineFailure) return;
    const retry = () => {
      if (chunk) window.location.reload();
      else {
        reset();
        void router.invalidate();
      }
    };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [offlineFailure, chunk, reset, router]);
  if (isApiError(error) && error.isForbidden) return <ForbiddenPage />;
  if (chunk) {
    return (
      <ErrorState
        title={STATE_COPY.pageLoadFailed}
        onRetry={() => window.location.reload()}
        retryLabel={STATE_COPY.reload}
      />
    );
  }
  return <ErrorState error={error} onRetry={reset} />;
}

/**
 * For errors thrown above any layout (guards, such as a holder on /admin): the holder shell, so a
 * signed-in visitor keeps My passes, Account and the account menu.
 */
export function StandaloneError(props: ErrorComponentProps) {
  return (
    <AppShell bar={<PortalBar />} width="holder" holder>
      <RouteError {...props} />
    </AppShell>
  );
}

import { type ErrorComponentProps, Link, useRouter, useRouterState } from '@tanstack/react-router';
import { LogIn, Search, WalletCards } from 'lucide-react';
import { useEffect } from 'react';
import { isApiError } from '../../lib/errors.ts';
import { isAdminPath } from '../../lib/guards.ts';
import { usePalette } from '../../lib/palette.ts';
import { signOut, useSession } from '../../lib/session.ts';
import { Button } from '../button.tsx';
import { EmptyState } from '../empty-state.tsx';
import { ErrorState, isChunkLoadError } from '../error-state.tsx';
import { AppShell } from './app-shell.tsx';
import { PortalBar } from './portal-layout.tsx';

const useInAdmin = () => useRouterState({ select: (s) => isAdminPath(s.location.pathname) });

export function ForbiddenPage() {
  const { authed } = useSession();
  // A holder who followed an admin link gets a way back to their passes.
  const holder = authed?.roles.includes('user') === true;
  return (
    <EmptyState
      heading
      art="lock"
      title="You do not have access"
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {holder ? (
            <Button variant="outline" asChild>
              <Link to="/">
                <WalletCards aria-hidden />
                Go to My passes
              </Link>
            </Button>
          ) : null}
          <Button
            variant={holder ? 'ghost' : 'outline'}
            iconStart={<LogIn aria-hidden />}
            onClick={() => void signOut(authed?.csrfToken)}
          >
            Sign in as someone else
          </Button>
        </div>
      }
    />
  );
}

export function NotFoundPage() {
  const inAdmin = useInAdmin();
  const palette = usePalette();
  if (!inAdmin) {
    return (
      <EmptyState
        heading
        art="wallet"
        artState="lost"
        title="Page not found"
        action={
          <Button asChild variant="outline">
            <Link to="/">Go to My passes</Link>
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      heading
      art="torn"
      title="Page not found"
      action={
        <div className="flex flex-wrap justify-center gap-2">
          {palette ? (
            <Button variant="outline" iconStart={<Search aria-hidden />} onClick={palette.open}>
              Search
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <Link to="/admin">Go to Overview</Link>
          </Button>
        </div>
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
        title="Could not load this page. Check your connection."
        onRetry={() => window.location.reload()}
        retryLabel="Reload"
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

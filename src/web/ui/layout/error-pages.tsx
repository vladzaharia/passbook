import { type ErrorComponentProps, Link, useRouterState } from '@tanstack/react-router';
import { LogIn, Search } from 'lucide-react';
import { isApiError } from '../../lib/errors.ts';
import { usePalette } from '../../lib/palette.ts';
import { MAIN_ID } from '../../lib/route-focus.tsx';
import { signOut, useSession } from '../../lib/session.ts';
import { Button } from '../button.tsx';
import { EmptyState } from '../empty-state.tsx';
import { ErrorState, isChunkLoadError } from '../error-state.tsx';
import { Wordmark } from './wordmark.tsx';

const useInAdmin = () =>
  useRouterState({ select: (s) => s.location.pathname.startsWith('/admin') });

export function ForbiddenPage() {
  const { authed } = useSession();
  return (
    <EmptyState
      heading
      art="lock"
      title="You do not have access"
      action={
        <Button
          variant="outline"
          iconStart={<LogIn aria-hidden />}
          onClick={() => void signOut(authed?.csrfToken)}
        >
          Sign in as someone else
        </Button>
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
  if (isApiError(error) && error.isForbidden) return <ForbiddenPage />;
  if (isChunkLoadError(error)) {
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

/** For errors thrown above any layout (guards): brings its own header and main. */
export function StandaloneError(props: ErrorComponentProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center px-safe pt-[env(safe-area-inset-top)]">
        <Wordmark />
      </header>
      <main id={MAIN_ID} tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-safe py-10">
        <RouteError {...props} />
      </main>
    </div>
  );
}

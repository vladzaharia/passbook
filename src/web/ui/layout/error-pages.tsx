import { Link, type ErrorComponentProps } from '@tanstack/react-router';
import { Ban, FileQuestion } from 'lucide-react';
import { isApiError } from '../../lib/errors.ts';
import { MAIN_ID } from '../../lib/route-focus.tsx';
import { ThemeToggle } from './theme-toggle.tsx';
import { Wordmark } from './wordmark.tsx';
import { buttonVariants } from '../button.tsx';
import { EmptyState } from '../empty-state.tsx';
import { ErrorState } from '../error-state.tsx';
import { PageHeader } from '../page-header.tsx';

const HOME = <Link to="/" className={buttonVariants({ variant: 'outline' })}>Home</Link>;

export function ForbiddenPage() {
  return (
    <>
      <PageHeader title="Forbidden" />
      <EmptyState icon={Ban} title="You do not have access" action={HOME} />
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState icon={FileQuestion} title="This page does not exist" action={HOME} />
    </>
  );
}

/** Route error component: 403 gets the forbidden page, everything else an ErrorState. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  if (isApiError(error) && error.isForbidden) return <ForbiddenPage />;
  return (
    <>
      <PageHeader title="Error" />
      <ErrorState error={error} title="Something broke" onRetry={reset} action={HOME} />
    </>
  );
}

/** For errors thrown above any layout (guards): brings its own header and main. */
export function StandaloneError(props: ErrorComponentProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center justify-between px-4">
        <Wordmark />
        <ThemeToggle />
      </header>
      <main id={MAIN_ID} tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
        <RouteError {...props} />
      </main>
    </div>
  );
}

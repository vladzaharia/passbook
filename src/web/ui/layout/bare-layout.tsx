import { Outlet } from '@tanstack/react-router';
import { MAIN_ID } from '../../lib/route-focus.tsx';
import { ThemeToggle } from './theme-toggle.tsx';
import { Wordmark } from './wordmark.tsx';

/** Signed-out pages (login). */
export function BareLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center justify-between px-4">
        <Wordmark />
        <ThemeToggle />
      </header>
      <main id={MAIN_ID} tabIndex={-1} className="mx-auto w-full max-w-sm flex-1 px-4 py-10">
        <Outlet />
      </main>
    </div>
  );
}

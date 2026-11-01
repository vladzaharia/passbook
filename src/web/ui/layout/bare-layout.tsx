import { Outlet } from '@tanstack/react-router';
import { MAIN_ID } from '../../lib/route-focus.tsx';
import { Wordmark } from './wordmark.tsx';

/** Signed-out pages (login): system appearance, no toggle; the sign-in scene is the moment. */
export function BareLayout() {
  return (
    <div className="wl-portal flex min-h-dvh flex-col">
      <header className="flex min-h-14 items-center px-safe pt-[env(safe-area-inset-top)]">
        <Wordmark flip={false} />
      </header>
      <main
        id={MAIN_ID}
        tabIndex={-1}
        className="mx-auto w-full max-w-sm flex-1 px-safe pt-10 pb-safe"
      >
        <Outlet />
      </main>
    </div>
  );
}

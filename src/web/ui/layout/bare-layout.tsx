import { Outlet } from '@tanstack/react-router';
import { MAIN_ID } from '../../lib/route-focus.tsx';

/**
 * Signed-out pages (login): the page draws its own hosted shell (wordmark, scene, card), which
 * the worker's SSR auth pages mirror. System appearance, no toggle.
 */
export function BareLayout() {
  return (
    <div className="wl-portal flex min-h-dvh flex-col">
      <main
        id={MAIN_ID}
        tabIndex={-1}
        className="w-full flex-1 px-safe pt-[env(safe-area-inset-top)] pb-safe"
      >
        <Outlet />
      </main>
    </div>
  );
}

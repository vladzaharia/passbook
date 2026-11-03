import { Outlet } from '@tanstack/react-router';
import { AppShell } from './app-shell.tsx';

/**
 * Signed-out pages (login): no top bar, the page draws its own hosted band (wordmark, scene,
 * card), which the worker's SSR auth pages mirror.
 */
export function BareLayout() {
  return (
    <AppShell width="full" holder>
      <Outlet />
    </AppShell>
  );
}

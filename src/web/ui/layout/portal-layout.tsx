import { Outlet } from '@tanstack/react-router';
import { ActivityTray } from './activity-tray.tsx';
import { AppShell, type AppShellProps } from './app-shell.tsx';
import { UserMenu } from './user-menu.tsx';
import { Wordmark } from './wordmark.tsx';

/** The holder's bar: the mark and the account menu, which carries My passes, Account and the rest. */
export const PORTAL_BAR: NonNullable<AppShellProps['bar']> = {
  brand: <Wordmark />,
  controls: <ActivityTray />,
  account: <UserMenu />,
};

export function PortalLayout() {
  return (
    <AppShell bar={PORTAL_BAR} width="holder" holder>
      <Outlet />
    </AppShell>
  );
}

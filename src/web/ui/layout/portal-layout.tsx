import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { cn } from '../../lib/cn.ts';
import { isActivePath, PORTAL_NAV } from '../../lib/nav.ts';
import { isAdmin, useSession } from '../../lib/session.ts';
import { ActiveIndicator } from '../active-indicator.tsx';
import { AppShell } from './app-shell.tsx';
import { UserMenu } from './user-menu.tsx';
import { Wordmark } from './wordmark.tsx';

const NAV_LINK =
  'relative inline-flex min-h-9 items-center whitespace-nowrap rounded-md px-2 text-sm wl-colors pointer-coarse:min-h-11 sm:px-3';

/**
 * The holder top bar: wordmark, My passes, Account and (admins, from 640) Admin, then the account
 * menu. Signed out, the wordmark alone.
 */
export function PortalBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { authed, session } = useSession();
  const admin = isAdmin(session);
  return (
    <>
      <Wordmark />
      {authed ? (
        <nav
          aria-label="Main"
          className="relative mr-auto flex min-w-0 gap-1 overflow-x-auto sm:ml-2"
        >
          <ActiveIndicator />
          {PORTAL_NAV.filter((item) => admin || !item.admin).map((item) => {
            const active = isActivePath(pathname, item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === '/' }}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  NAV_LINK,
                  active ? 'text-fg-strong' : 'text-fg-muted hover:text-fg-strong',
                  // Phones have no room for it; the account menu carries Admin there.
                  item.admin && 'max-sm:hidden',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      ) : (
        <span className="mr-auto" />
      )}
      <UserMenu />
    </>
  );
}

export function PortalLayout() {
  return (
    <AppShell bar={<PortalBar />} width="holder" holder>
      <Outlet />
    </AppShell>
  );
}

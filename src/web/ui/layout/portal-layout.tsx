import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { cn } from '../../lib/cn.ts';
import { isActivePath, PORTAL_NAV } from '../../lib/nav.ts';
import { MAIN_ID } from '../../lib/route-focus.tsx';
import { isAdmin as hasAdmin, useSession } from '../../lib/session.ts';
import { ActiveIndicator } from '../active-indicator.tsx';
import { OfflineBanner } from '../offline-banner.tsx';
import { UserMenu } from './user-menu.tsx';
import { Wordmark } from './wordmark.tsx';

const NAV_LINK =
  'relative inline-flex min-h-8 items-center whitespace-nowrap rounded-md px-2 text-sm wl-colors pointer-coarse:min-h-11 sm:px-3';

/** Holder pages follow the system appearance: no theme toggle here. */
export function PortalLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { session } = useSession();
  return (
    <div className="wl-portal flex min-h-dvh flex-col">
      <header className="border-b border-border bg-surface-raised pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex min-h-14 w-full max-w-5xl items-center gap-1 px-safe sm:gap-4">
          <Wordmark />
          <nav aria-label="Main" className="relative mr-auto flex min-w-0 gap-1 overflow-x-auto">
            <ActiveIndicator />
            {PORTAL_NAV.map((item) => {
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
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
            {hasAdmin(session) ? (
              <Link
                to="/admin"
                className={cn(NAV_LINK, 'text-fg-muted hover:text-fg-strong max-sm:hidden')}
              >
                Admin
              </Link>
            ) : null}
          </nav>
          <UserMenu />
        </div>
      </header>
      <OfflineBanner />
      <main
        id={MAIN_ID}
        tabIndex={-1}
        className="mx-auto w-full max-w-5xl flex-1 px-safe pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      >
        <Outlet />
      </main>
    </div>
  );
}

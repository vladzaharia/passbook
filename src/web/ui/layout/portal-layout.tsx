import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { cn } from '../../lib/cn.ts';
import { isActivePath, PORTAL_NAV } from '../../lib/nav.ts';
import { MAIN_ID } from '../../lib/route-focus.tsx';
import { isAdmin as hasAdmin, useSession } from '../../lib/session.ts';
import { ThemeToggle } from './theme-toggle.tsx';
import { UserMenu } from './user-menu.tsx';
import { Wordmark } from './wordmark.tsx';

export function PortalLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { session } = useSession();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-surface-raised">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-2 px-4 sm:gap-4">
          <Wordmark />
          <nav aria-label="Main" className="mr-auto flex min-w-0 gap-1 overflow-x-auto">
            {PORTAL_NAV.map((item) => {
              const active = isActivePath(pathname, item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to as never}
                  activeOptions={{ exact: item.to === '/' }}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex min-h-8 items-center whitespace-nowrap rounded-md px-3 text-sm',
                    active
                      ? 'bg-state-selected-fill text-fg-strong'
                      : 'text-fg-muted hover:text-fg-strong',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
            {hasAdmin(session) ? (
              <Link
                to={'/admin' as never}
                className="inline-flex min-h-8 items-center whitespace-nowrap rounded-md px-3 text-sm text-fg-muted hover:text-fg-strong"
              >
                Admin
              </Link>
            ) : null}
          </nav>
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>
      <main id={MAIN_ID} tabIndex={-1} className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}

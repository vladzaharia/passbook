import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { cn } from '../../lib/cn.ts';
import {
  adminEntryPath,
  entryOrgId,
  isActivePath,
  isOrgScoped,
  PORTAL_NAV,
} from '../../lib/nav.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useSession } from '../../lib/session.ts';
import { ActiveIndicator } from '../active-indicator.tsx';
import { AppShell } from './app-shell.tsx';
import { UserMenu } from './user-menu.tsx';
import { Wordmark } from './wordmark.tsx';

const NAV_LINK =
  'relative inline-flex min-h-9 items-center whitespace-nowrap rounded-md px-2 text-sm wl-colors pointer-coarse:min-h-11 sm:px-3';

/** Holder navigation also exposes the console to users with active memberships. */
function PortalNav({ platformAdmin }: { platformAdmin: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const scope = useOrgScope();
  const ready = !scope.isLoading && !scope.isError;
  const memberships = ready ? scope.memberships : [];
  const membership = ready ? scope.membership : undefined;
  const consolePath = adminEntryPath(platformAdmin, membership, memberships);
  const canEnter = platformAdmin || memberships.length > 0;
  return (
    <nav aria-label="Main" className="relative mr-auto flex min-w-0 gap-1 overflow-x-auto sm:ml-2">
      <ActiveIndicator />
      {PORTAL_NAV.filter((item) => canEnter || !item.admin).map((item) => {
        const to = item.admin ? consolePath : item.to;
        const active = isActivePath(pathname, to);
        return (
          <Link
            key={item.to}
            to={to}
            search={
              item.admin
                ? { orgId: isOrgScoped(to) ? entryOrgId(membership, memberships) : undefined }
                : undefined
            }
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
      {scope.isError ? (
        <button
          type="button"
          className={cn(NAV_LINK, 'text-fg-muted hover:text-fg-strong')}
          onClick={() => void scope.refetch()}
        >
          Retry organization access
        </button>
      ) : scope.isLoading ? (
        <span role="status" className="sr-only">
          Loading organization access…
        </span>
      ) : null}
    </nav>
  );
}

/** The signed-out bar makes no membership request. */
export function PortalBar() {
  const { authed, isAdmin } = useSession();
  return (
    <>
      <Wordmark />
      {authed ? <PortalNav platformAdmin={isAdmin} /> : <span className="mr-auto" />}
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

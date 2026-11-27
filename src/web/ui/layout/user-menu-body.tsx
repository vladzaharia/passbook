import { Link, useRouterState } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { canUseSpace, needsPocketId, SPACE_HOME, SPACES, type Space } from '@/shared/spaces.ts';
import { isAdminPath } from '../../lib/guards.ts';
import { accountPath, isActivePath } from '../../lib/nav.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { personLabel } from '../../lib/person-label.ts';
import { type AuthedSession, signOut } from '../../lib/session.ts';
import { DropdownMenuItem } from '../dropdown-menu.tsx';
import { AccountMenu, type LinkProps, type SpaceEntry } from './account-menu.tsx';

/** Which space the page belongs to. */
function spaceOf(pathname: string): Space {
  if (isActivePath(pathname, accountPath(pathname))) return 'account';
  if (isActivePath(pathname, SPACE_HOME.workbench)) return 'workbench';
  return isAdminPath(pathname) ? 'admin' : 'passes';
}

/** The developer site is its own document: a full page load, not a route. */
function SpaLink({ href, space, ...props }: LinkProps) {
  if (space === 'developers') return <a href={href} {...props} />;
  return <Link to={href} {...props} />;
}

export function SignedInUserMenu({
  authed,
  defaultOpen,
  extra,
}: {
  authed: AuthedSession;
  defaultOpen: boolean;
  extra?: ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const scope = useOrgScope();
  const ready = !scope.isLoading && !scope.isError;
  const orgMember = ready && scope.memberships.length > 0;
  const current = spaceOf(pathname);
  const spaces: SpaceEntry[] = SPACES.filter((space) =>
    canUseSpace(space, {
      amr: authed.amr,
      roles: authed.roles,
      orgMember,
      consoleUntil: authed.consoleUntil,
      consoleGroupRequired: authed.consoleGroupRequired,
    }),
  ).map((space) => ({
    space,
    // Inside the console Account keeps its sidebar, unless an email link cannot open the console.
    href:
      space === 'account' && !needsPocketId('admin', authed.amr, authed.consoleUntil)
        ? accountPath(pathname)
        : SPACE_HOME[space],
    current: space === current,
  }));
  const { user } = authed;
  return (
    <AccountMenu
      user={user}
      label={personLabel(user)}
      spaces={spaces}
      link={SpaLink}
      defaultOpen={defaultOpen}
      onSignOut={() => void signOut(authed.csrfToken)}
      extra={
        <>
          {scope.isError ? (
            <DropdownMenuItem onSelect={() => void scope.refetch()}>
              <RefreshCw aria-hidden />
              Retry organization access
            </DropdownMenuItem>
          ) : null}
          {extra}
        </>
      }
    />
  );
}

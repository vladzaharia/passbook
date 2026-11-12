import * as Menu from '@radix-ui/react-dropdown-menu';
import { Link, useRouterState } from '@tanstack/react-router';
import {
  Check,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  RefreshCw,
  Ticket,
  UserRound,
} from 'lucide-react';
import { THEME_ICON } from '../../lib/action-icons.ts';
import { cn } from '../../lib/cn.ts';
import { isAdminPath } from '../../lib/guards.ts';
import { useChangeCount } from '../../lib/motion.ts';
import {
  accountPath,
  adminEntryPath,
  entryOrgId,
  isActivePath,
  isOrgScoped,
} from '../../lib/nav.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { type AuthedSession, signOut, useSession } from '../../lib/session.ts';
import { THEME_OPTIONS, type ThemePref, useTheme } from '../../lib/theme.tsx';
import { ActiveIndicator } from '../active-indicator.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu.tsx';
import { EntityAvatar } from '../entity.tsx';
import { IconButton } from '../icon-button.tsx';

/** A segmented control made of menu radio items, so arrow keys and focus stay in the menu. */
function ThemeChoice() {
  const { pref, setPref } = useTheme();
  const changed = useChangeCount(pref);
  return (
    <div className="px-2 py-1.5">
      <p id="theme-label" className="mb-1.5 text-xs text-fg-muted">
        Theme
      </p>
      <Menu.RadioGroup
        aria-labelledby="theme-label"
        value={pref}
        onValueChange={(v) => setPref(v as ThemePref)}
        className="relative flex rounded-md border border-border bg-surface-sunken p-0.5"
      >
        <ActiveIndicator variant="thumb" />
        {THEME_OPTIONS.map((t) => {
          const on = t.value === pref;
          const Icon = THEME_ICON[t.value];
          return (
            <Menu.RadioItem
              key={t.value}
              value={t.value}
              onSelect={(e) => e.preventDefault()}
              className={cn(
                'relative flex min-h-7 flex-1 cursor-pointer select-none items-center justify-center gap-1.5 rounded-[5px] px-2 text-xs font-medium outline-hidden wl-colors pointer-coarse:min-h-11',
                'data-highlighted:text-fg-strong data-highlighted:outline-2 data-highlighted:outline-focus [html[data-modality=pointer]_&]:data-highlighted:outline-none',
                on ? 'text-fg-strong' : 'text-fg-muted',
              )}
            >
              <Icon
                key={on ? changed : 'idle'}
                aria-hidden
                className={cn('size-3.5', on && changed > 0 && 'wl-seg-icon')}
              />
              {t.label}
            </Menu.RadioItem>
          );
        })}
      </Menu.RadioGroup>
    </div>
  );
}

type Face = 'passes' | 'account' | 'admin';

/** Which face of the app the page belongs to: My passes, Account or the console. */
function faceOf(pathname: string): Face {
  if (isActivePath(pathname, accountPath(pathname))) return 'account';
  return isAdminPath(pathname) ? 'admin' : 'passes';
}

function FaceItem({
  to,
  icon: Icon,
  label,
  current,
  orgId,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  current: boolean;
  orgId?: string | undefined;
}) {
  return (
    <DropdownMenuItem asChild>
      <Link
        to={to}
        search={isAdminPath(to) ? { orgId } : undefined}
        aria-current={current ? 'page' : undefined}
      >
        <Icon aria-hidden />
        {label}
        {current ? <Check aria-hidden className="ml-auto text-accent-fg!" /> : null}
      </Link>
    </DropdownMenuItem>
  );
}

/** The account menu opens the console for platform admins and active organization members. */
export function UserMenu() {
  const { authed, isAdmin } = useSession();
  return authed ? <SignedInUserMenu authed={authed} platformAdmin={isAdmin} /> : null;
}

function SignedInUserMenu({
  authed,
  platformAdmin,
}: {
  authed: AuthedSession;
  platformAdmin: boolean;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const scope = useOrgScope();
  const ready = !scope.isLoading && !scope.isError;
  const memberships = ready ? scope.memberships : [];
  const membership = ready ? scope.membership : undefined;
  const consolePath = adminEntryPath(platformAdmin, membership, memberships);
  const { user } = authed;
  const face = faceOf(pathname);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton
          label="Account menu"
          icon={<EntityAvatar kind="user" id={user.id} name={user.name ?? user.primaryEmail} />}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          <span className="block truncate text-fg-strong">{user.name ?? user.primaryEmail}</span>
          {user.name ? (
            <span className="block truncate text-fg-muted">{user.primaryEmail}</span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <FaceItem to="/" icon={Ticket} label="My passes" current={face === 'passes'} />
        <FaceItem
          to={accountPath(pathname)}
          icon={UserRound}
          label="Account"
          current={face === 'account'}
        />
        {platformAdmin || memberships.length > 0 ? (
          <FaceItem
            to={consolePath}
            orgId={isOrgScoped(consolePath) ? entryOrgId(membership, memberships) : undefined}
            icon={LayoutDashboard}
            label="Admin"
            current={face === 'admin'}
          />
        ) : null}
        {scope.isError ? (
          <DropdownMenuItem onSelect={() => void scope.refetch()}>
            <RefreshCw aria-hidden />
            Retry organization access
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <ThemeChoice />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut(authed.csrfToken)}>
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

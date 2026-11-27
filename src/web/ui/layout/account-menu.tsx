import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  Check,
  Code,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Ticket,
  UserRound,
  Wrench,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import type { Space } from '@/shared/spaces.ts';
import { THEME_ICON } from '../../lib/action-icons.ts';
import { useChangeCount } from '../../lib/change-count.ts';
import { cn } from '../../lib/cn.ts';
import { THEME_OPTIONS, type ThemePref, useTheme } from '../../lib/theme.tsx';
import { ActiveIndicator } from '../active-indicator.tsx';
import { EntityAvatar } from '../avatar.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useIgnoreOpeningGesture,
} from '../dropdown-menu.tsx';
import { IconButton } from '../icon-button.tsx';

/** A segmented control made of menu radio items, so arrow keys and focus stay in the menu. */
function ThemeChoice() {
  const { pref, setPref } = useTheme();
  const changed = useChangeCount(pref);
  const opening = useIgnoreOpeningGesture();
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
              {...opening}
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

const SPACE_ICON: Record<Space, LucideIcon> = {
  passes: Ticket,
  account: UserRound,
  admin: LayoutDashboard,
  workbench: Wrench,
  developers: Code,
};

export const SPACE_LABEL: Record<Space, string> = {
  passes: 'My passes',
  account: 'Account',
  admin: 'Admin',
  workbench: 'Workbench',
  developers: 'Developers',
};

export interface SpaceEntry {
  space: Space;
  href: string;
  current: boolean;
}

export interface LinkProps {
  href: string;
  space: Space;
  className?: string;
  'aria-current'?: 'page';
  children: ReactNode;
}

/** An anchor: the developer site, and any space that is another document. */
export function PlainLink({ href, space: _space, ...props }: LinkProps) {
  return <a href={href} {...props} />;
}

export interface AccountMenuProps {
  user: { id: string; name: string | null; primaryEmail: string | null };
  /** Only the spaces this person can use, in menu order. */
  spaces: readonly SpaceEntry[];
  /** How a space opens: the SPA routes inside itself, the developer site loads pages. */
  link?: (props: LinkProps) => ReactElement;
  onSignOut: () => void;
  /** Extra items after the spaces (the console's "Retry organization access"). */
  extra?: ReactNode;
  defaultOpen?: boolean;
  label: string;
}

/**
 * The account menu, one component in every space: who you are, the spaces you can use with the
 * current one checked, the theme, Sign out. It knows no router, so the developer site's island
 * loads it as it is.
 */
export function AccountMenu({
  user,
  spaces,
  link: Link = PlainLink,
  onSignOut,
  extra,
  defaultOpen,
  label,
}: AccountMenuProps) {
  return (
    <DropdownMenu modal={false} defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>
        <IconButton
          label="Account menu"
          icon={<EntityAvatar kind="user" id={user.id} name={label} />}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          <span className="block truncate text-fg-strong">{label}</span>
          {user.name && user.primaryEmail ? (
            <span className="block truncate text-fg-muted">{user.primaryEmail}</span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {spaces.map(({ space, href, current }) => {
          const Icon = SPACE_ICON[space];
          return (
            <DropdownMenuItem asChild key={space}>
              <Link href={href} space={space} aria-current={current ? 'page' : undefined}>
                <Icon aria-hidden />
                {SPACE_LABEL[space]}
                {current ? <Check aria-hidden className="ml-auto text-accent-fg!" /> : null}
              </Link>
            </DropdownMenuItem>
          );
        })}
        {extra}
        <DropdownMenuSeparator />
        <ThemeChoice />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut}>
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

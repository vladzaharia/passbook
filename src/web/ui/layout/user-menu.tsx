import * as Menu from '@radix-ui/react-dropdown-menu';
import { Link } from '@tanstack/react-router';
import { LogOut, Ticket, UserRound } from 'lucide-react';
import { THEME_ICON } from '../../lib/action-icons.ts';
import { cn } from '../../lib/cn.ts';
import { useChangeCount } from '../../lib/motion.ts';
import { signOut, useSession } from '../../lib/session.ts';
import { type ThemePref, useTheme } from '../../lib/theme.tsx';
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

const THEMES = [
  { value: 'system', label: 'System', icon: THEME_ICON.system },
  { value: 'light', label: 'Light', icon: THEME_ICON.light },
  { value: 'dark', label: 'Dark', icon: THEME_ICON.dark },
] as const;

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
        {THEMES.map((t) => {
          const on = t.value === pref;
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
              <t.icon
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

/** Account menu. The admin console adds My passes and the theme (System, Light, Dark). */
export function UserMenu({ admin = false }: { admin?: boolean }) {
  const { authed } = useSession();
  if (!authed) return null;
  const { user } = authed;
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
        {admin ? (
          <DropdownMenuItem asChild>
            <Link to="/">
              <Ticket aria-hidden />
              My passes
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem asChild>
          <Link to="/account">
            <UserRound aria-hidden />
            Account
          </Link>
        </DropdownMenuItem>
        {admin ? (
          <>
            <DropdownMenuSeparator />
            <ThemeChoice />
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut(authed.csrfToken)}>
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

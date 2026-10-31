import { Link } from '@tanstack/react-router';
import { LogOut, User } from 'lucide-react';
import { useSession, signOut } from '../../lib/session.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu.tsx';
import { IconButton } from '../icon-button.tsx';

export function UserMenu() {
  const { authed } = useSession();
  if (!authed) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Account menu" icon={<User aria-hidden />} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <span className="block max-w-56 truncate">{authed.user.name ?? authed.user.primaryEmail}</span>
          {authed.user.name ? (
            <span className="block max-w-56 truncate text-fg-subtle">{authed.user.primaryEmail}</span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account">Account</Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void signOut(authed.csrfToken)}>
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

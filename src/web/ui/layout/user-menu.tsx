import { Link } from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { AUTH_PAGE_COPY } from '@/shared/copy/auth-page.ts';
import { personLabel } from '../../lib/person-label.ts';
import { useSession } from '../../lib/session.ts';
import { EntityAvatar } from '../avatar.tsx';
import { IconButton } from '../icon-button.tsx';
import { SignInButton } from './menubar.tsx';

// The menu's Radix chunks stay out of the initial load (bundle budget); a click before they arrive
// opens the menu on load.
const Menu = lazy(() =>
  import('./user-menu-body.tsx').then((m) => ({ default: m.SignedInUserMenu })),
);

/**
 * The bar's last control in every space: the account menu, or Sign in when nobody is. `extra` is a
 * space's own items after the spaces (the Workbench's Keyboard shortcuts).
 */
export function UserMenu({ extra }: { extra?: ReactNode } = {}) {
  const { authed, isPending } = useSession();
  const [asked, setAsked] = useState(false);
  if (!authed) {
    // Nothing until the session is known: no Sign in flashing for a signed-in person.
    if (isPending) return null;
    return (
      <SignInButton>
        <Link to="/login">{AUTH_PAGE_COPY.signIn}</Link>
      </SignInButton>
    );
  }
  const { user } = authed;
  return (
    <Suspense
      fallback={
        <IconButton
          label="Account menu"
          icon={<EntityAvatar kind="user" id={user.id} name={personLabel(user)} />}
          onClick={() => setAsked(true)}
        />
      }
    >
      <Menu authed={authed} defaultOpen={asked} extra={extra} />
    </Suspense>
  );
}

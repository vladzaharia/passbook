import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { AUTH_PAGE_COPY } from '@/shared/copy/sign-in.ts';
import { personLabel } from '../../lib/format.ts';
import { useSession } from '../../lib/session.ts';
import { EntityAvatar } from '../avatar.tsx';
import { IconButton } from '../icon-button.tsx';
import { SignInButton } from './menubar.tsx';

// The menu's Radix chunks stay out of the initial load (bundle budget); a click before they arrive
// opens the menu on load.
const Menu = lazy(() =>
  import('./user-menu-body.tsx').then((m) => ({ default: m.SignedInUserMenu })),
);

/** The bar's last control in every space: the account menu, or Sign in when nobody is. */
export function UserMenu() {
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
      <Menu authed={authed} defaultOpen={asked} />
    </Suspense>
  );
}

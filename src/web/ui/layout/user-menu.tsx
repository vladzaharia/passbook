import { lazy, Suspense, useState } from 'react';
import { personLabel } from '../../lib/format.ts';
import { useSession } from '../../lib/session.ts';
import { EntityAvatar } from '../entity.tsx';
import { IconButton } from '../icon-button.tsx';

// The menu's Radix chunks stay out of the initial load (bundle budget); a click before they arrive
// opens the menu on load.
const Menu = lazy(() =>
  import('./user-menu-body.tsx').then((m) => ({ default: m.SignedInUserMenu })),
);

/** The account menu opens the console for platform admins and active organization members. */
export function UserMenu() {
  const { authed, isAdmin } = useSession();
  const [asked, setAsked] = useState(false);
  if (!authed) return null;
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
      <Menu authed={authed} platformAdmin={isAdmin} defaultOpen={asked} />
    </Suspense>
  );
}

import { lazy, Suspense } from 'react';
import { useSession } from '../../lib/session.ts';

// Popover, sheet and the progress panel stay out of the entry chunk (bundle budget): the tray
// loads once a person is signed in, and draws nothing until an operation runs or has just ended.
const Body = lazy(() => import('./activity-tray-body.tsx'));

/** The bar's activity indicator for the admin and the holder portal (the `controls` slot). */
export function ActivityTray() {
  const { authed } = useSession();
  if (!authed) return null;
  return (
    <Suspense fallback={null}>
      <Body />
    </Suspense>
  );
}

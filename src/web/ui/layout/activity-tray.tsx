import { lazy, Suspense } from 'react';
import { useSession } from '../../lib/session.ts';
import type { OperationsClient } from '../operation/client.ts';
import type { Operation } from '../operation/types.ts';

// Popover, sheet and the progress panel stay out of the entry chunk (bundle budget): the tray
// loads once a person is signed in, and draws nothing until an operation runs or has just ended.
const Body = lazy(() => import('./activity-tray-body.tsx'));

export interface ActivityTrayProps {
  /** The client the tray polls and acts through; the session's when omitted (admin, the portal). */
  client?: OperationsClient;
  /** Which operations it lists; all of the person's when omitted. Keep it stable. */
  include?: (op: Operation) => boolean;
  /** Where the tray's "All activity" link goes, when the host has a full list. */
  allHref?: string;
}

/** The bar's activity indicator for the admin, the holder portal and the Workbench (the `controls` slot). */
export function ActivityTray(props: ActivityTrayProps) {
  const { authed } = useSession();
  if (!authed) return null;
  return (
    <Suspense fallback={null}>
      <Body {...props} />
    </Suspense>
  );
}

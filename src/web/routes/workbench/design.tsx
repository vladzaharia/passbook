import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { useSession } from '../../lib/session.ts';
import { AnonPage } from '../../workbench/design/anon/anon-page.tsx';
import { isHandoffHash } from '../../workbench/design/anon/handoff.ts';
import { enterContext } from '../../workbench/host/entry.ts';
import { WorkbenchEntry } from '../../workbench/states/entry.tsx';

const HandoffEntry = lazy(() => import('../../workbench/design/anon/handoff-entry.tsx'));

/**
 * `/workbench/design`: signed in, Design in the remembered context, else the chooser (the same
 * entry as every context-free path); signed out, the blueprints in the designer (design §1.9). A
 * save from the signed-out page comes back here with `s=1` and goes to the sandbox, not the
 * remembered context.
 */
function DesignEntry() {
  const { authed } = useSession();
  if (!authed) return <AnonPage />;
  if (isHandoffHash(location.hash))
    return (
      <Suspense fallback={null}>
        <HandoffEntry />
      </Suspense>
    );
  return <WorkbenchEntry />;
}

export const Route = createFileRoute('/workbench/design')({
  beforeLoad: ({ context, location }) =>
    isHandoffHash(location.hash)
      ? undefined
      : enterContext(context.queryClient, 'design', location),
  component: DesignEntry,
});

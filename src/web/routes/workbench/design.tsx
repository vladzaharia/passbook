import { createFileRoute } from '@tanstack/react-router';
import { useSession } from '../../lib/session.ts';
import { enterContext } from '../../workbench/host/entry.ts';
import { WorkbenchEntry } from '../../workbench/states/entry.tsx';
import { PlaygroundPage } from '../../workbench/tools/tool-playground.tsx';

/**
 * `/workbench/design`: signed in, Design in the remembered context, else the chooser (the same
 * entry as every context-free path); signed out, the Playground (design §1.9, DC3).
 */
function DesignEntry() {
  const { authed } = useSession();
  return authed ? <WorkbenchEntry /> : <PlaygroundPage />;
}

export const Route = createFileRoute('/workbench/design')({
  beforeLoad: ({ context, location }) => enterContext(context.queryClient, 'design', location),
  component: DesignEntry,
});

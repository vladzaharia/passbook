import { createFileRoute } from '@tanstack/react-router';
import { QuickstartPage } from '../../workbench/tools/tool-quickstart.tsx';

/** Quickstart: the sandbox's guided run, public at step 1 (design §1.11). T8 rebuilds it. */
export const Route = createFileRoute('/workbench/quickstart')({
  // The old page's `#sandbox`, `#start-over` and `#delete-sandbox` go to the Sandbox area.
  beforeLoad: async ({ location }) => {
    if (location.hash)
      (await import('../../workbench/host/legacy-hash.ts')).redirectLegacy('quickstart', location);
  },
  component: QuickstartPage,
});

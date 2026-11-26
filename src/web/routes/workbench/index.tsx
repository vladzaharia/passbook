import { createFileRoute } from '@tanstack/react-router';
import { enterContext } from '../../workbench/host/entry.ts';
import { WorkbenchEntry } from '../../workbench/states/entry.tsx';

/** `/workbench`: Home of the remembered context, else the sandbox's, else the chooser. */
export const Route = createFileRoute('/workbench/')({
  beforeLoad: ({ context, location }) => enterContext(context.queryClient, 'home', location),
  component: WorkbenchEntry,
});

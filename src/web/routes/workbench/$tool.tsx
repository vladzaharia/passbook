import { createFileRoute, notFound } from '@tanstack/react-router';
import { isWbTool } from '@/shared/workbench.ts';
import { enterContext } from '../../workbench/host/entry.ts';
import { WorkbenchEntry } from '../../workbench/states/entry.tsx';

/**
 * `/workbench/<tool>…` with no context (a docs link, an old bookmark): the same area in the
 * remembered context, the query and hash kept. Design and Quickstart have pages of their own.
 */
export const Route = createFileRoute('/workbench/$tool')({
  beforeLoad: ({ context, location, params }) => {
    if (!isWbTool(params.tool)) throw notFound();
    return enterContext(context.queryClient, params.tool, location);
  },
  component: WorkbenchEntry,
});

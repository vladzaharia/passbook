import { createFileRoute } from '@tanstack/react-router';
import { ToolPlaceholder } from '../../workbench/tools/placeholder.tsx';

/** Quickstart: the sandbox's guided run, public at step 1 (design §1.11). T8 fills it in. */
export const Route = createFileRoute('/workbench/quickstart')({
  component: () => <ToolPlaceholder tool="quickstart" />,
});

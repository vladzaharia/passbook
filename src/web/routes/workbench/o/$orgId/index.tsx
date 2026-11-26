import { createFileRoute } from '@tanstack/react-router';
import { ToolPlaceholder } from '../../../../workbench/tools/placeholder.tsx';

/** Home: the loop at a glance, live while visible (design §1.7). T1 fills it in. */
export const Route = createFileRoute('/workbench/o/$orgId/')({
  component: () => <ToolPlaceholder tool="home" />,
});

import { createFileRoute } from '@tanstack/react-router';
import { ToolPlaceholder } from '../../../../workbench/tools/placeholder.tsx';

export const Route = createFileRoute('/workbench/o/$orgId/activity')({
  component: () => <ToolPlaceholder tool="activity" />,
});

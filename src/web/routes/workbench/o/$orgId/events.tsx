import { createFileRoute } from '@tanstack/react-router';
import { ToolPlaceholder } from '../../../../workbench/tools/placeholder.tsx';

export const Route = createFileRoute('/workbench/o/$orgId/events')({
  component: () => <ToolPlaceholder tool="events" />,
});

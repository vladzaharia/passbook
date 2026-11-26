import { createFileRoute } from '@tanstack/react-router';
import { ToolPlaceholder } from '../../../../workbench/tools/placeholder.tsx';

export const Route = createFileRoute('/workbench/o/$orgId/console')({
  component: () => <ToolPlaceholder tool="console" />,
});

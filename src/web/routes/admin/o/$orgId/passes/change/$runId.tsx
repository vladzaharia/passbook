import { createFileRoute } from '@tanstack/react-router';
import { ChangeRunPage } from '../../../../../../admin/passes/change/run-page.tsx';

function RunRoute() {
  const { runId } = Route.useParams();
  return <ChangeRunPage runId={runId} />;
}

export const Route = createFileRoute('/admin/o/$orgId/passes/change/$runId')({
  component: RunRoute,
});

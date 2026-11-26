import { createFileRoute } from '@tanstack/react-router';
import { ConnectionDetailPage } from '../../../../../admin/connections/detail-page.tsx';
import { LiveOnly } from '../../../../../admin/connections/live-only.tsx';

function ConnectionSetupRoute() {
  const { connectionId } = Route.useParams();
  return (
    <LiveOnly>
      <ConnectionDetailPage connectionId={connectionId} search={{}} setup />
    </LiveOnly>
  );
}

export const Route = createFileRoute('/admin/o/$orgId/connections/$connectionId_/setup')({
  component: ConnectionSetupRoute,
});

import { createFileRoute } from '@tanstack/react-router';
import { EndpointDetailPage } from '../../../../../admin/connections/webhooks/detail-page.tsx';

function EndpointRoute() {
  const { endpointId } = Route.useParams();
  return <EndpointDetailPage endpointId={endpointId} />;
}

export const Route = createFileRoute('/admin/o/$orgId/connections/webhooks/$endpointId')({
  component: EndpointRoute,
});

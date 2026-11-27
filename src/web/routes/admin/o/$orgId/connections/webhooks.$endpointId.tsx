import { createFileRoute } from '@tanstack/react-router';
import { EndpointDetailPage } from '../../../../../admin/connections/webhooks/detail-page.tsx';
import { endpointDetailSearchSchema } from '../../../../../admin/connections/webhooks/detail-tabs.ts';

function EndpointRoute() {
  const { endpointId } = Route.useParams();
  const { tab } = Route.useSearch();
  return <EndpointDetailPage endpointId={endpointId} tab={tab} />;
}

export const Route = createFileRoute('/admin/o/$orgId/connections/webhooks/$endpointId')({
  validateSearch: endpointDetailSearchSchema,
  component: EndpointRoute,
});

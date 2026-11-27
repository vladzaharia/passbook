import { createFileRoute } from '@tanstack/react-router';
import { OutboundResume } from '../../../../../admin/connections/webhooks/outbound-resume.tsx';

function EndpointSetupRoute() {
  const { endpointId } = Route.useParams();
  return <OutboundResume endpointId={endpointId} />;
}

export const Route = createFileRoute('/admin/o/$orgId/connections/webhooks/$endpointId_/setup')({
  component: EndpointSetupRoute,
});

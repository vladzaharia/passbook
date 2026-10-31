import { createFileRoute } from '@tanstack/react-router';
import { ConnectionDetailPage } from '../../../admin/connections/detail-page.tsx';

function ConnectionRoute() {
  const { connectionId } = Route.useParams();
  return <ConnectionDetailPage connectionId={connectionId} />;
}

export const Route = createFileRoute('/admin/connections/$connectionId')({
  component: ConnectionRoute,
});

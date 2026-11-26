import { createFileRoute } from '@tanstack/react-router';
import { ConnectionDetailPage } from '../../../../../admin/connections/detail-page.tsx';
import { LiveOnly } from '../../../../../admin/connections/live-only.tsx';
import { connectionDetailSearchSchema } from '../../../../../admin/connections/search.ts';

function ConnectionRoute() {
  const { connectionId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <LiveOnly>
      <ConnectionDetailPage connectionId={connectionId} search={search} />
    </LiveOnly>
  );
}

export const Route = createFileRoute('/admin/o/$orgId/connections/$connectionId')({
  validateSearch: connectionDetailSearchSchema,
  component: ConnectionRoute,
});

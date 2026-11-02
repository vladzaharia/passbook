import { createFileRoute } from '@tanstack/react-router';
import { connectionDetailQuery } from '../../../admin/connections/api.ts';
import { ConnectionDetailPage } from '../../../admin/connections/detail-page.tsx';
import { connectionDetailSearchSchema } from '../../../admin/connections/search.ts';

function ConnectionRoute() {
  const { connectionId } = Route.useParams();
  const search = Route.useSearch();
  return <ConnectionDetailPage connectionId={connectionId} search={search} />;
}

export const Route = createFileRoute('/admin/connections/$connectionId')({
  validateSearch: connectionDetailSearchSchema,
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(connectionDetailQuery(params.connectionId));
  },
  component: ConnectionRoute,
});

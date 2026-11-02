import { createFileRoute } from '@tanstack/react-router';
import { passDetailQuery } from '../../../admin/passes/api.ts';
import { PassDetailPage } from '../../../admin/passes/detail/detail-page.tsx';
import { passDetailSearchSchema } from '../../../admin/passes/search.ts';

function PassRoute() {
  const { passId } = Route.useParams();
  const search = Route.useSearch();
  return <PassDetailPage passId={passId} search={search} />;
}

export const Route = createFileRoute('/admin/passes/$passId')({
  validateSearch: passDetailSearchSchema,
  // Not awaited: the GET starts with the chunk download (and on link hover), the page reads the cache.
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(passDetailQuery(params.passId));
  },
  component: PassRoute,
});

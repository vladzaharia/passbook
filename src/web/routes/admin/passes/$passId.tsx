import { createFileRoute } from '@tanstack/react-router';
import { PassDetailPage } from '../../../admin/passes/detail/detail-page.tsx';
import { passDetailSearchSchema } from '../../../admin/passes/search.ts';

function PassRoute() {
  const { passId } = Route.useParams();
  const search = Route.useSearch();
  return <PassDetailPage passId={passId} search={search} />;
}

export const Route = createFileRoute('/admin/passes/$passId')({
  validateSearch: passDetailSearchSchema,
  component: PassRoute,
});

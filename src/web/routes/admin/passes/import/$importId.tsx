import { createFileRoute } from '@tanstack/react-router';
import { ImportDetailPage } from '../../../../admin/passes/import/detail-page.tsx';
import { importSearchSchema } from '../../../../admin/passes/import/search.ts';

function ImportRoute() {
  const { importId } = Route.useParams();
  return <ImportDetailPage importId={importId} />;
}

export const Route = createFileRoute('/admin/passes/import/$importId')({
  validateSearch: importSearchSchema,
  component: ImportRoute,
});

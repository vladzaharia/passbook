import { createFileRoute } from '@tanstack/react-router';
import { BlueprintDetailPage } from '../../../admin/blueprints/blueprint-page.tsx';
import { blueprintSearchSchema } from '../../../admin/templates/search.ts';

function BlueprintRoute() {
  const { blueprintId } = Route.useParams();
  const { tab } = Route.useSearch();
  return <BlueprintDetailPage blueprintId={blueprintId} tab={tab} />;
}

export const Route = createFileRoute('/admin/blueprints/$blueprintId')({
  validateSearch: blueprintSearchSchema,
  component: BlueprintRoute,
});

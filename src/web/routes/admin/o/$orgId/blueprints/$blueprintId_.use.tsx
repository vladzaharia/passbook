import { createFileRoute } from '@tanstack/react-router';
import { UseBlueprintPage } from '../../../../../admin/blueprints/use-page.tsx';

function UseRoute() {
  const { blueprintId, orgId } = Route.useParams();
  return <UseBlueprintPage blueprintId={blueprintId} orgId={orgId} />;
}

export const Route = createFileRoute('/admin/o/$orgId/blueprints/$blueprintId_/use')({
  component: UseRoute,
});

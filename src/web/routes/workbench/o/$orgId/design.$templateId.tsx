import { createFileRoute } from '@tanstack/react-router';
import { designSearchSchema } from '../../../../admin/templates/designer/design-search.ts';
import { DesignPage } from '../../../../workbench/design/design-page.tsx';

function DesignRoute() {
  const { templateId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <DesignPage
      templateId={templateId}
      view={search}
      onView={(next) => void navigate({ search: next, replace: true })}
    />
  );
}

export const Route = createFileRoute('/workbench/o/$orgId/design/$templateId')({
  validateSearch: designSearchSchema,
  component: DesignRoute,
});

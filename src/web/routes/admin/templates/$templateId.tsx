import { createFileRoute } from '@tanstack/react-router';
import { TemplateDetailPage } from '../../../admin/templates/detail-page.tsx';
import { templateDetailSearchSchema } from '../../../admin/templates/search.ts';

function TemplateRoute() {
  const { templateId } = Route.useParams();
  const search = Route.useSearch();
  return <TemplateDetailPage templateId={templateId} search={search} />;
}

export const Route = createFileRoute('/admin/templates/$templateId')({
  validateSearch: templateDetailSearchSchema,
  component: TemplateRoute,
});

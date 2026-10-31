import { createFileRoute } from '@tanstack/react-router';
import { TemplateDetailPage } from '../../../admin/templates/detail-page.tsx';

function TemplateRoute() {
  const { templateId } = Route.useParams();
  return <TemplateDetailPage templateId={templateId} />;
}

export const Route = createFileRoute('/admin/templates/$templateId')({
  component: TemplateRoute,
});

import { createFileRoute } from '@tanstack/react-router';
import { TemplateDesignerPage } from '../../../admin/templates/designer/designer-page.tsx';

function DesignRoute() {
  const { templateId } = Route.useParams();
  return <TemplateDesignerPage templateId={templateId} />;
}

export const Route = createFileRoute('/admin/templates/$templateId_/design')({
  component: DesignRoute,
});

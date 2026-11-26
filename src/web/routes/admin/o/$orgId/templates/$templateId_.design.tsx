import { createFileRoute } from '@tanstack/react-router';
import { designSearchSchema } from '../../../../../admin/templates/designer/design-search.ts';
import { TemplateDesignerPage } from '../../../../../admin/templates/designer/designer-page.tsx';

function DesignRoute() {
  const { templateId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <TemplateDesignerPage
      templateId={templateId}
      view={search}
      onView={(next) => {
        if (next.mode === search.mode && next.wallet === search.wallet) return;
        void navigate({
          search: (prev) => ({ ...prev, mode: next.mode, wallet: next.wallet }),
          replace: true,
        });
      }}
    />
  );
}

export const Route = createFileRoute('/admin/o/$orgId/templates/$templateId_/design')({
  validateSearch: designSearchSchema,
  component: DesignRoute,
});

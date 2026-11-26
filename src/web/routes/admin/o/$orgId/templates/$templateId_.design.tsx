import { createFileRoute } from '@tanstack/react-router';
import { TemplateDesignerPage } from '../../../../../admin/templates/designer/admin/designer-page.tsx';
import { designSearchSchema } from '../../../../../admin/templates/designer/design-search.ts';

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

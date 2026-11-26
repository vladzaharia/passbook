import { createFileRoute } from '@tanstack/react-router';
import { NewTemplatePage } from '../../../../../admin/templates/designer/admin/new-page.tsx';
import { newTemplateSearchSchema } from '../../../../../admin/templates/search.ts';

function NewTemplateRoute() {
  const { blueprint, name } = Route.useSearch();
  return <NewTemplatePage blueprintId={blueprint} name={name} />;
}

export const Route = createFileRoute('/admin/o/$orgId/templates/new')({
  validateSearch: newTemplateSearchSchema,
  component: NewTemplateRoute,
});

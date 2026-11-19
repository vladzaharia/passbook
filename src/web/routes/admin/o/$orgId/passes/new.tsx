import { createFileRoute } from '@tanstack/react-router';
import { NewPassPage } from '../../../../../admin/passes/new-pass-page.tsx';
import { newPassSearchSchema } from '../../../../../admin/passes/search.ts';

function NewPassRoute() {
  const { templateId } = Route.useSearch();
  return <NewPassPage templateId={templateId} />;
}

export const Route = createFileRoute('/admin/o/$orgId/passes/new')({
  validateSearch: newPassSearchSchema,
  component: NewPassRoute,
});

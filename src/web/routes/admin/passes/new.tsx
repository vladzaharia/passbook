import { createFileRoute } from '@tanstack/react-router';
import { NewPassPage } from '../../../admin/passes/new-pass-page.tsx';
import { newPassSearchSchema } from '../../../admin/passes/search.ts';

function NewPassRoute() {
  const { orgId, templateId } = Route.useSearch();
  return <NewPassPage orgId={orgId} templateId={templateId} />;
}

export const Route = createFileRoute('/admin/passes/new')({
  validateSearch: newPassSearchSchema,
  component: NewPassRoute,
});

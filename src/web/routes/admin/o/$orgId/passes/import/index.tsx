import { createFileRoute } from '@tanstack/react-router';
import { ImportPage } from '../../../../../../admin/passes/import/import-page.tsx';
import { importSearchSchema } from '../../../../../../admin/passes/import/search.ts';

export const Route = createFileRoute('/admin/o/$orgId/passes/import/')({
  validateSearch: importSearchSchema,
  component: ImportPage,
});

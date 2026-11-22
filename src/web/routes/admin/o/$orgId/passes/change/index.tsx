import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ChangePage } from '../../../../../../admin/passes/change/change-page.tsx';

const opt = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

function ChangeRoute() {
  const { importId, templateId, kind, tell } = Route.useSearch();
  return <ChangePage search={{ importId, templateId, kind, tell }} />;
}

export const Route = createFileRoute('/admin/o/$orgId/passes/change/')({
  validateSearch: z.object({
    importId: opt(z.string()),
    templateId: opt(z.string()),
    kind: opt(z.enum(['fields', 'design', 'void'])),
    tell: opt(z.boolean()),
  }),
  component: ChangeRoute,
});

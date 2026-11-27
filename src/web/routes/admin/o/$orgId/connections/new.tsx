import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { CreateConnectionWizard } from '../../../../../admin/connections/create-wizard.tsx';
import { LiveOnly } from '../../../../../admin/connections/live-only.tsx';

function NewConnectionRoute() {
  const { source } = Route.useSearch();
  return (
    <LiveOnly>
      <CreateConnectionWizard source={source} />
    </LiveOnly>
  );
}

export const Route = createFileRoute('/admin/o/$orgId/connections/new')({
  validateSearch: z.object({ source: z.string().max(60).optional().catch(undefined) }),
  component: NewConnectionRoute,
});

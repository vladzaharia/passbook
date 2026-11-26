import { createFileRoute } from '@tanstack/react-router';
import { CreateConnectionWizard } from '../../../../../admin/connections/create-wizard.tsx';
import { LiveOnly } from '../../../../../admin/connections/live-only.tsx';

function NewConnectionRoute() {
  return (
    <LiveOnly>
      <CreateConnectionWizard />
    </LiveOnly>
  );
}

export const Route = createFileRoute('/admin/o/$orgId/connections/new')({
  component: NewConnectionRoute,
});

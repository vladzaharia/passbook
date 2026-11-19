import { createFileRoute } from '@tanstack/react-router';
import { CreateConnectionWizard } from '../../../../../admin/connections/create-wizard.tsx';

export const Route = createFileRoute('/admin/o/$orgId/connections/new')({
  component: CreateConnectionWizard,
});

import { createFileRoute } from '@tanstack/react-router';
import { BlueprintsPage } from '../../../../../admin/blueprints/blueprints-page.tsx';

export const Route = createFileRoute('/admin/o/$orgId/blueprints/')({
  component: BlueprintsPage,
});

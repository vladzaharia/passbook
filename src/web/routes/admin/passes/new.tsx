import { createFileRoute } from '@tanstack/react-router';
import { RoutePlaceholder } from '../../../ui/route-placeholder.tsx';

export const Route = createFileRoute('/admin/passes/new')({
  component: () => (
    <RoutePlaceholder
      title="New pass"
      breadcrumbs={[{ label: 'Passes', to: '/admin/passes' }, { label: 'New' }]}
    />
  ),
});

import { createFileRoute } from '@tanstack/react-router';
import { RoutePlaceholder } from '../../../ui/route-placeholder.tsx';

export const Route = createFileRoute('/admin/connections/new')({
  component: () => <RoutePlaceholder title="New connection" breadcrumbs={[{ label: 'Connections', to: '/admin/connections' }, { label: 'New' }]} />,
});

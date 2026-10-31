import { createFileRoute } from '@tanstack/react-router';
import { RoutePlaceholder } from '../../../ui/route-placeholder.tsx';

export const Route = createFileRoute('/admin/connections/$connectionId')({
  component: () => <RoutePlaceholder title="Connection" breadcrumbs={[{ label: 'Connections', to: '/admin/connections' }, { label: 'Connection' }]} />,
});

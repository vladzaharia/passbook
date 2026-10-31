import { createFileRoute } from '@tanstack/react-router';
import { RoutePlaceholder } from '../../../ui/route-placeholder.tsx';

export const Route = createFileRoute('/admin/users/$userId')({
  component: () => <RoutePlaceholder title="User" breadcrumbs={[{ label: 'Users', to: '/admin/users' }, { label: 'User' }]} />,
});

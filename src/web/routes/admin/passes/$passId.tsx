import { createFileRoute } from '@tanstack/react-router';
import { RoutePlaceholder } from '../../../ui/route-placeholder.tsx';

export const Route = createFileRoute('/admin/passes/$passId')({
  component: () => <RoutePlaceholder title="Pass" breadcrumbs={[{ label: 'Passes', to: '/admin/passes' }, { label: 'Pass' }]} />,
});

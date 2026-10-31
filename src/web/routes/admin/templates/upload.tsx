import { createFileRoute } from '@tanstack/react-router';
import { RoutePlaceholder } from '../../../ui/route-placeholder.tsx';

export const Route = createFileRoute('/admin/templates/upload')({
  component: () => <RoutePlaceholder title="Upload template" breadcrumbs={[{ label: 'Templates', to: '/admin/templates' }, { label: 'Upload' }]} />,
});

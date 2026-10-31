import { createFileRoute } from '@tanstack/react-router';
import { RoutePlaceholder } from '../../../ui/route-placeholder.tsx';

export const Route = createFileRoute('/admin/orgs/$orgId')({
  component: () => (
    <RoutePlaceholder
      title="Organization"
      breadcrumbs={[{ label: 'Organizations', to: '/admin/orgs' }, { label: 'Organization' }]}
    />
  ),
});

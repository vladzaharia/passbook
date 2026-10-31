import { createFileRoute } from '@tanstack/react-router';
import { RoutePlaceholder } from '../../../ui/route-placeholder.tsx';

export const Route = createFileRoute('/admin/templates/$templateId')({
  component: () => (
    <RoutePlaceholder
      title="Template"
      breadcrumbs={[{ label: 'Templates', to: '/admin/templates' }, { label: 'Template' }]}
    />
  ),
});

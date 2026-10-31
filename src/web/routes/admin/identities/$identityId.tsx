import { createFileRoute } from '@tanstack/react-router';
import { RoutePlaceholder } from '../../../ui/route-placeholder.tsx';

export const Route = createFileRoute('/admin/identities/$identityId')({
  component: () => <RoutePlaceholder title="Apple identity" breadcrumbs={[{ label: 'Apple identities', to: '/admin/identities' }, { label: 'Identity' }]} />,
});

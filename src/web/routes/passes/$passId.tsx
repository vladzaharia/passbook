import { createFileRoute } from '@tanstack/react-router';
import { RoutePlaceholder } from '../../ui/route-placeholder.tsx';

export const Route = createFileRoute('/passes/$passId')({
  component: () => <RoutePlaceholder title="Pass" breadcrumbs={[{ label: 'My passes', to: '/' }, { label: 'Pass' }]} />,
});

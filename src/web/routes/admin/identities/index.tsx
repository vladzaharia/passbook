import { createFileRoute } from '@tanstack/react-router';
import { RoutePlaceholder } from '../../../ui/route-placeholder.tsx';

export const Route = createFileRoute('/admin/identities/')({
  component: () => <RoutePlaceholder title="Apple identities" />,
});

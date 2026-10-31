import { createFileRoute } from '@tanstack/react-router';
import { RoutePlaceholder } from '../../../ui/route-placeholder.tsx';

export const Route = createFileRoute('/admin/api-keys/')({
  component: () => <RoutePlaceholder title="API keys" />,
});

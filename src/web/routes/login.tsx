import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { RoutePlaceholder } from '../ui/route-placeholder.tsx';

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ next: z.string().optional() }),
  component: () => <RoutePlaceholder title="Sign in" />,
});

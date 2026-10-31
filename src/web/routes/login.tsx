import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { LoginPage } from '../portal/login-page.tsx';

export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    next: z.string().optional().catch(undefined),
    error: z.string().optional().catch(undefined),
  }),
  component: function LoginRoute() {
    const { next, error } = Route.useSearch();
    return <LoginPage next={next} error={error} />;
  },
});

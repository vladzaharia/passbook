import { createFileRoute } from '@tanstack/react-router';
import { requireAdmin } from '../../lib/guards.ts';
import { AdminLayout } from '../../ui/layout/admin-layout.tsx';
import { StandaloneError } from '../../ui/layout/error-pages.tsx';

export const Route = createFileRoute('/admin')({
  beforeLoad: async ({ context, location }) => {
    await requireAdmin(context.queryClient, location.href);
  },
  component: AdminLayout,
  errorComponent: StandaloneError,
});

import { createFileRoute, retainSearchParams } from '@tanstack/react-router';
import { requireAdmin } from '../../lib/guards.ts';
import { orgScopeSearchSchema } from '../../lib/route-search.ts';
import { AdminLayout } from '../../ui/layout/admin-layout.tsx';
import { StandaloneError } from '../../ui/layout/error-pages.tsx';

export const Route = createFileRoute('/admin')({
  // The org scope rides along between admin pages; unscoped pages strip it (UNSCOPED_SEARCH).
  validateSearch: orgScopeSearchSchema,
  search: { middlewares: [retainSearchParams(['orgId'])] },
  beforeLoad: async ({ context, location }) => {
    await requireAdmin(context.queryClient, location.href);
  },
  component: AdminLayout,
  errorComponent: StandaloneError,
  // Split the console only: the error page is the holder shell, already in the entry, and a
  // separate chunk for it pulls shared shell modules out of the entry into extra preloads.
  codeSplitGroupings: [['component']],
});

import { createFileRoute, retainSearchParams } from '@tanstack/react-router';
import { requireAdmin } from '../../lib/guards.ts';
import { orgScopeSearchSchema, seedOrgScope } from '../../lib/org-filter.tsx';
import { AdminLayout } from '../../ui/layout/admin-layout.tsx';
import { StandaloneError } from '../../ui/layout/error-pages.tsx';

export const Route = createFileRoute('/admin')({
  // The org scope rides along between admin pages; unscoped pages strip it (UNSCOPED_SEARCH).
  validateSearch: orgScopeSearchSchema,
  search: { middlewares: [retainSearchParams(['orgId'])] },
  beforeLoad: async ({ context, location, preload }) => {
    await requireAdmin(context.queryClient, location.href);
    seedOrgScope(location, preload);
  },
  component: AdminLayout,
  errorComponent: StandaloneError,
});

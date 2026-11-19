import { createFileRoute, Outlet } from '@tanstack/react-router';
import { requireAdminConsole } from '../../lib/guards.ts';
import { orgScopeSearchSchema } from '../../lib/route-search.ts';
import { AdminLayout } from '../../ui/layout/admin-layout.tsx';
import { StandaloneError } from '../../ui/layout/error-pages.tsx';

function AdminRouteLayout() {
  // The scope gates (platform/route.tsx, o/$orgId/route.tsx) decide what each page shows.
  return (
    <AdminLayout>
      <Outlet />
    </AdminLayout>
  );
}

export const Route = createFileRoute('/admin')({
  // Old links still pass ?orgId=; the legacy routes turn it into the path.
  validateSearch: orgScopeSearchSchema,
  beforeLoad: async ({ context, location }) => {
    await requireAdminConsole(context.queryClient, location.href);
  },
  component: AdminRouteLayout,
  errorComponent: StandaloneError,
  // Split the console only: the error page is the holder shell, already in the entry, and a
  // separate chunk for it pulls shared shell modules out of the entry into extra preloads.
  codeSplitGroupings: [['component']],
});

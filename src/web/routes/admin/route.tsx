import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { needsPocketId } from '@/shared/spaces.ts';
import { requireAdminConsole } from '../../lib/guards.ts';
import { orgScopeSearchSchema } from '../../lib/route-search.ts';
import { useSession } from '../../lib/session.ts';
import { AdminLayout } from '../../ui/layout/admin-layout.tsx';
import { AppShell } from '../../ui/layout/app-shell.tsx';
import { StandaloneError } from '../../ui/layout/error-pages.tsx';
import { PolarisIdRequired } from '../../ui/layout/polaris-id-required.tsx';
import { PORTAL_BAR } from '../../ui/layout/portal-layout.tsx';

function AdminRouteLayout() {
  const { authed } = useSession();
  const here = useRouterState({ select: (s) => s.location.href });
  // An email link opens the holder's spaces only: the console waits for Polaris ID.
  if (authed && needsPocketId('admin', authed.amr, authed.consoleUntil)) {
    return (
      <AppShell bar={PORTAL_BAR} width="holder" holder>
        <PolarisIdRequired space="Admin" next={here} />
      </AppShell>
    );
  }
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

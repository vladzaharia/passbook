import {
  createFileRoute,
  Outlet,
  retainSearchParams,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import {
  canAccessAdminPath,
  isTenantAdminPath,
  isTenantResourceDetail,
  requireAdminConsole,
} from '../../lib/guards.ts';
import { adminEntryPath, entryOrgId, sectionLabel } from '../../lib/nav.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { orgScopeSearchSchema } from '../../lib/route-search.ts';
import { useSession } from '../../lib/session.ts';
import { DetailNotFound, EmptyState } from '../../ui/empty-state.tsx';
import { ErrorState } from '../../ui/error-state.tsx';
import { AdminLayout } from '../../ui/layout/admin-layout.tsx';
import { ForbiddenPage, ScopedDeniedPage, StandaloneError } from '../../ui/layout/error-pages.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';

/** Keep the shell mounted so the selector can repair missing or denied tenant scope. */
function AdminRouteGate() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const view = useRouterState({ select: (state) => state.location.search.view });
  const notFound = useRouterState({
    select: (state) =>
      state.matches.some((match) => match._notFound || match.status === 'notFound'),
  });
  const session = useSession();
  const { isAdmin } = session;
  const principalId = session.authed?.user.id;
  const scope = useOrgScope();
  const workspace = view === 'workspace' ? view : undefined;
  const isPassWizard = pathname.replace(/\/+$/, '') === '/admin/passes/new';
  const admittedWizard = useRef<
    | {
        principalId: string;
        selection: string | undefined;
        explicit: boolean;
      }
    | undefined
  >(undefined);
  const admitted = admittedWizard.current;
  const sameWizardScope =
    isPassWizard &&
    principalId !== undefined &&
    admitted !== undefined &&
    admitted.principalId === principalId &&
    admitted.selection === scope.requestedSelection &&
    admitted.explicit === scope.hasExplicitOrg;
  const wizardAuthorized =
    isPassWizard &&
    !notFound &&
    principalId !== undefined &&
    !scope.isLoading &&
    !scope.isError &&
    (scope.hasExplicitOrg
      ? scope.requestedOrgId !== undefined &&
        scope.requestedOrgId === scope.membership?.orgId &&
        canAccessAdminPath(pathname, isAdmin, scope.membership, workspace)
      : scope.membership
        ? canAccessAdminPath(pathname, isAdmin, scope.membership, workspace)
        : scope.memberships.some((membership) =>
            canAccessAdminPath(pathname, isAdmin, membership, workspace),
          ));

  useEffect(() => {
    if (wizardAuthorized && principalId) {
      admittedWizard.current = {
        principalId,
        selection: scope.requestedSelection,
        explicit: scope.hasExplicitOrg,
      };
    } else if (!scope.isLoading || scope.isError || !sameWizardScope) {
      admittedWizard.current = undefined;
    }
  }, [
    wizardAuthorized,
    principalId,
    scope.requestedSelection,
    scope.hasExplicitOrg,
    scope.isLoading,
    scope.isError,
    sameWizardScope,
  ]);

  // A member has no overview: /admin opens the first section their role covers.
  const atOverview = pathname.replace(/\/+$/, '') === '/admin';
  const leaving =
    atOverview && !isAdmin && !scope.isLoading && !scope.isError && scope.memberships.length > 0;
  const entryTo = leaving ? adminEntryPath(false, scope.membership, scope.memberships) : undefined;
  const entryOrg = leaving ? entryOrgId(scope.membership, scope.memberships) : undefined;
  const navigate = useNavigate();
  useEffect(() => {
    if (entryTo) void navigate({ to: entryTo, search: { orgId: entryOrg }, replace: true });
  }, [entryTo, entryOrg, navigate]);

  if (notFound) return <Outlet />;
  if (entryTo) return <SkeletonRows label="Opening your workspace" />;

  // Global pages and bare organization details do not depend on membership loading.
  if (canAccessAdminPath(pathname, isAdmin, undefined, workspace)) return <Outlet />;
  if (!isTenantAdminPath(pathname, workspace)) return <ForbiddenPage />;
  // Only an already admitted wizard for this exact principal and choice may keep its draft.
  // Its own queries and create action still require fresh grants.
  if (scope.isLoading)
    return sameWizardScope ? <Outlet /> : <SkeletonRows label="Loading organization access" />;
  if (scope.isError) {
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  }

  // A bare workspace deep link may resolve its path org only after an actual grant is found.
  if (workspace && /^\/admin\/orgs\/[^/]+\/?$/.test(pathname)) {
    const authorized = scope.hasExplicitOrg
      ? scope.requestedOrgId !== undefined &&
        scope.requestedOrgId === scope.membership?.orgId &&
        canAccessAdminPath(pathname, isAdmin, scope.membership, workspace)
      : scope.memberships.some((membership) =>
          canAccessAdminPath(pathname, isAdmin, membership, workspace),
        );
    return authorized ? (
      <Outlet />
    ) : (
      <DetailNotFound
        heading
        entity="org"
        to={isAdmin ? '/admin/orgs' : '/admin/account'}
        back={isAdmin ? undefined : 'Account'}
      />
    );
  }
  // A linked ID takes precedence over browser storage and must identify the selected membership.
  if (
    scope.hasExplicitOrg &&
    (scope.requestedOrgId === undefined || scope.requestedOrgId !== scope.membership?.orgId)
  ) {
    return <ForbiddenPage />;
  }
  if (!scope.hasExplicitOrg && isTenantResourceDetail(pathname, workspace)) {
    // The detail validates its actual organization before displaying or canonicalizing anything.
    return scope.memberships.some((membership) =>
      canAccessAdminPath(pathname, isAdmin, membership, workspace),
    ) ? (
      <Outlet />
    ) : (
      <ForbiddenPage />
    );
  }
  if (scope.membership) {
    if (canAccessAdminPath(pathname, isAdmin, scope.membership, workspace)) return <Outlet />;
    const { membership } = scope;
    const to = adminEntryPath(false, membership);
    return (
      <ScopedDeniedPage
        orgName={membership.orgName}
        section={sectionLabel(pathname)}
        entry={{ to, label: sectionLabel(to), orgId: membership.orgId }}
      />
    );
  }
  const hasAuthorizedMembership = scope.memberships.some((membership) =>
    canAccessAdminPath(pathname, isAdmin, membership, workspace),
  );
  if (!hasAuthorizedMembership) return <ForbiddenPage />;
  if (pathname.replace(/\/+$/, '') === '/admin/passes/new' && !scope.hasExplicitOrg) {
    // The pass wizard's first step makes an explicit authorized organization choice.
    return <Outlet />;
  }
  return <EmptyState heading art="building" title="Choose an organization" />;
}

function AdminRouteLayout() {
  return (
    <AdminLayout>
      <AdminRouteGate />
    </AdminLayout>
  );
}

export const Route = createFileRoute('/admin')({
  // Carry tenant scope between pages; audit and API keys also use orgId as a platform filter.
  validateSearch: orgScopeSearchSchema,
  search: { middlewares: [retainSearchParams(['orgId'])] },
  beforeLoad: async ({ context, location }) => {
    await requireAdminConsole(context.queryClient, location.href);
  },
  component: AdminRouteLayout,
  errorComponent: StandaloneError,
  // Split the console only: the error page is the holder shell, already in the entry, and a
  // separate chunk for it pulls shared shell modules out of the entry into extra preloads.
  codeSplitGroupings: [['component']],
});
